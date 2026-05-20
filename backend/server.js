const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('MediaForge backend is running'));

// Write cookies if provided
if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync('./cookies.txt', process.env.YOUTUBE_COOKIES);
    console.log('Cookies file written');
} else {
    console.warn('No YOUTUBE_COOKIES – YouTube may need a proxy or will use Invidious fallback');
}

// ========== yt-dlp helper (with optional proxy) ==========
function ytDlp(args) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = './yt-dlp';
        const fullArgs = [
            '--js-runtime', 'node',
            '--cookies', './cookies.txt',
        ];
        // If you later add a PAID residential proxy, set YTDLP_PROXY env variable
        if (process.env.YTDLP_PROXY) {
            fullArgs.push('--proxy', process.env.YTDLP_PROXY);
        }
        fullArgs.push(...args);
        execFile(ytDlpPath, fullArgs, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout.trim());
        });
    });
}

// ========== Invidious fallback ==========
const invidiousInstances = [
    'https://vid.puffyan.us',
    'https://invidious.snopyta.org',
    'https://yewtu.be',
    'https://invidious.fdn.fr',
    'https://invidious.nerdvpn.de',
];

async function tryInvidious(videoId) {
    for (const instance of invidiousInstances) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const resp = await fetch(`${instance}/api/v1/videos/${videoId}`, { signal: controller.signal });
            clearTimeout(timeout);
            if (!resp.ok) continue;
            const data = await resp.json();
            const format = data.formatStreams
                ?.filter(f => f.container === 'mp4' && f.audioChannels > 0)
                ?.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
            if (!format) continue;
            return {
                title: data.title,
                thumbnail: data.videoThumbnails?.[0]?.url || '',
                downloadUrl: format.url,
            };
        } catch (e) { /* try next */ }
    }
    return null;
}

// ========== YouTube endpoint (cookies -> Invidious) ==========
app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const idMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:&|$|\/|\.)/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (!idMatch) return res.status(400).json({ error: 'Invalid YouTube URL' });
    const videoId = idMatch[1];

    // 1. Try yt-dlp with cookies (and optional paid proxy)
    try {
        const json = await ytDlp(['--dump-json', '--no-playlist', url]);
        const info = JSON.parse(json);
        const format = (info.formats || [])
            .filter(f => f.acodec !== 'none' && f.vcodec !== 'none')
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (!format) throw new Error('No combined format');
        const directUrl = await ytDlp(['-f', format.format_id, '-g', url]);
        return res.json({ title: info.title, thumbnail: info.thumbnail, downloadUrl: directUrl });
    } catch (ytErr) {
        console.warn('yt-dlp failed:', ytErr.message);
    }

    // 2. Fallback to Invidious
    const invidiousResult = await tryInvidious(videoId);
    if (invidiousResult) {
        return res.json(invidiousResult);
    }

    // 3. All failed
    res.status(500).json({ error: 'All YouTube extraction methods failed. Please try again later.' });
});

// ========== TikTok ==========
app.get('/api/tiktok', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const resp = await fetch(apiUrl);
        const data = await resp.json();
        if (data.code !== 0 || !data.data) throw new Error(data.msg || 'TikTok API error');
        const v = data.data;
        const directUrl = v.hdplay || v.play || v.wmplay;
        if (!directUrl) throw new Error('No video URL');
        res.json({
            title: v.title || 'TikTok Video',
            thumbnail: v.cover || '',
            duration: v.duration || 'Unknown',
            author: v.author?.nickname || '',
            downloadUrl: directUrl,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== Facebook / general info & download (yt-dlp) ==========
const cache = new Map();
app.get('/api/info', async (req, res) => {
    const { url, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const json = await ytDlp(['--dump-json', '--no-playlist', url]);
        const info = JSON.parse(json);
        const thumbnail = info.thumbnail || info.thumbnails?.[0]?.url || '';
        let formatId = 'best';
        if (format === 'mp3') {
            const bestAudio = (info.formats || [])
                .filter(f => f.acodec !== 'none' && f.vcodec === 'none')
                .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
            if (bestAudio) formatId = bestAudio.format_id;
        } else {
            const combined = (info.formats || [])
                .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.height || 0) - (a.height || 0));
            if (combined.length) formatId = combined[0].format_id;
        }
        res.json({ title: info.title, thumbnail, duration: info.duration_string || `${Math.floor(info.duration||0)}s`, formatId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/download', async (req, res) => {
    const { url, formatId } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const key = `${url}|${formatId||'best'}`;
    if (cache.has(key) && Date.now() - cache.get(key).ts < 10*60*1000) {
        return res.json({ downloadUrl: cache.get(key).url });
    }
    try {
        const directUrl = await ytDlp(['-f', formatId || 'best', '-g', '--no-playlist', url]);
        cache.set(key, { url: directUrl, ts: Date.now() });
        res.json({ downloadUrl: directUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== Proxy download (forces file save) ==========
app.get('/api/proxy-download', async (req, res) => {
    const { url, title, ext } = req.query;
    if (!url) return res.status(400).send('Missing URL');
    try {
        const videoResp = await fetch(url);
        if (!videoResp.ok) throw new Error(`CDN returned ${videoResp.status}`);
        const fileName = (title || 'video').replace(/[^a-zA-Z0-9\s]/g, '').trim() + '.' + (ext || 'mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', videoResp.headers.get('content-type') || 'video/mp4');
        videoResp.body.pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== Start server ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Backend running on port ${PORT}`);
});