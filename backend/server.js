const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check (so Render doesn't think it's dead)
app.get('/', (req, res) => res.send('MediaForge backend is running'));

// ========== yt-dlp helper (with JS runtime & Android client) ==========
function ytDlp(args) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = './yt-dlp';
        const fullArgs = [
            '--js-runtime', 'node',
            '--extractor-args', 'youtube:player_client=android',
            ...args
        ];
        execFile(ytDlpPath, fullArgs, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout.trim());
        });
    });
}

// ========== CACHE (ONLY ONCE) ==========
const cache = new Map();

// ========== YOUTUBE / FACEBOOK (via yt-dlp) ==========
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
            else {
                const bestVideo = (info.formats || [])
                    .filter(f => f.vcodec !== 'none' && f.acodec === 'none')
                    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
                const bestAudio = (info.formats || [])
                    .filter(f => f.acodec !== 'none' && f.vcodec === 'none')
                    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
                if (bestVideo && bestAudio) formatId = `${bestVideo.format_id}+${bestAudio.format_id}`;
            }
        }
        res.json({ title: info.title, thumbnail, duration: info.duration_string || `${Math.floor(info.duration||0)}s`, formatId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/download', async (req, res) => {
    const { url, formatId } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const key = `${url}|${formatId || 'best'}`;
    if (cache.has(key) && Date.now() - cache.get(key).ts < 10 * 60 * 1000) {
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

// ========== TIKTOK (via tikwm.com) ==========
app.get('/api/tiktok', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.code !== 0 || !data.data) throw new Error(data.msg || 'TikTok API error');
        const v = data.data;
        const directUrl = v.hdplay || v.play || v.wmplay;
        if (!directUrl) throw new Error('No video URL');
        res.json({
            title: v.title || 'TikTok Video',
            thumbnail: v.cover || '',
            duration: v.duration || 'Unknown',
            author: v.author?.nickname || '',
            downloadUrl: directUrl
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== YOUTUBE FALLBACK (Invidious API) ==========
// ========== YOUTUBE FALLBACK (Multiple Invidious instances) ==========
const invidiousInstances = [
    'https://vid.puffyan.us',
    'https://invidious.snopyta.org',
    'https://invidious.fdn.fr',
    'https://yewtu.be',
    'https://invidious.nerdvpn.de',
];

app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const idMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:&|$|\/|\.)/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (!idMatch) return res.status(400).json({ error: 'Invalid YouTube URL' });
    const videoId = idMatch[1];

    let lastError;
    for (const instance of invidiousInstances) {
        try {
            const apiUrl = `${instance}/api/v1/videos/${videoId}`;
            const response = await fetch(apiUrl);
            if (!response.ok) continue; // try next instance
            const data = await response.json();
            const format = data.formatStreams
                ?.filter(f => f.container === 'mp4' && f.audioChannels > 0)
                ?.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
            if (!format) continue;
            res.json({
                title: data.title,
                thumbnail: data.videoThumbnails?.[0]?.url || '',
                duration: `${Math.floor(data.lengthSeconds / 60)}:${String(data.lengthSeconds % 60).padStart(2, '0')}`,
                downloadUrl: format.url,
            });
            return; // success
        } catch (err) {
            lastError = err.message;
        }
    }
    res.status(500).json({ error: 'All Invidious instances failed: ' + lastError });
});

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Backend running on port ${PORT}`);
});