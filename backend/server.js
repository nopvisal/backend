const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => res.send('MediaForge backend is running'));

// Helper function for yt-dlp (no cookies, just proxy)
function ytDlp(args) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = './yt-dlp';
        const fullArgs = [
            '--no-warnings', '--no-playlist',
            '--socket-timeout', '30',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            '--extractor-args', 'youtube:player_client=android',
        ];

        // Use the residential proxy from the environment variable
        if (process.env.YTDLP_PROXY) {
            fullArgs.push('--proxy', process.env.YTDLP_PROXY);
        }

        fullArgs.push(...args);

        execFile(ytDlpPath, fullArgs, { timeout: 30000, maxBuffer: 15 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout.trim());
        });
    });
}

// Simple fetch helper with timeout
function fetchWithTimeout(url, options = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        fetch(url, { ...options, signal: controller.signal })
            .then(res => { clearTimeout(timer); resolve(res); })
            .catch(err => { clearTimeout(timer); reject(err); });
    });
}

// YouTube endpoint (uses proxy)
app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        // Get video info and direct download URL
        const json = await ytDlp(['--dump-single-json', url]);
        const info = JSON.parse(json);
        const formats = (info.formats || [])
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
            .sort((a, b) => (b.height || 0) - (a.height || 0));
        if (formats.length === 0) throw new Error('No downloadable format');
        const directUrl = await ytDlp(['-f', formats[0].format_id, '-g', url]);
        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration_string,
            quality: formats[0].height ? `${formats[0].height}p` : 'Unknown',
            downloadUrl: directUrl,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// TikTok endpoint (unchanged)
app.get('/api/tiktok', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const resp = await fetchWithTimeout(apiUrl);
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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Facebook endpoint (uses proxy)
const cache = new Map();
app.get('/api/info', async (req, res) => {
    const { url, format } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const json = await ytDlp(['--dump-single-json', url]);
        const info = JSON.parse(json);
        let formatId = 'best';
        if (format === 'mp3') {
            const bestAudio = (info.formats || []).filter(f => f.acodec !== 'none' && f.vcodec === 'none')
                .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
            if (bestAudio) formatId = bestAudio.format_id;
        } else {
            const combined = (info.formats || []).filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.height || 0) - (a.height || 0));
            if (combined.length) formatId = combined[0].format_id;
        }
        res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration_string, formatId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/download', async (req, res) => {
    const { url, formatId } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const key = `${url}|${formatId || 'best'}`;
    if (cache.has(key) && Date.now() - cache.get(key).ts < 10 * 60 * 1000) {
        return res.json({ downloadUrl: cache.get(key).url });
    }
    try {
        const directUrl = await ytDlp(['-f', formatId || 'best', '-g', url]);
        cache.set(key, { url: directUrl, ts: Date.now() });
        res.json({ downloadUrl: directUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PROXY DOWNLOAD (forces file save, not preview in browser)
app.get('/api/proxy-download', async (req, res) => {
    const { url, title, ext } = req.query;
    if (!url) return res.status(400).send('Missing URL');
    try {
        const videoResp = await fetchWithTimeout(url, {}, 20000);
        if (!videoResp.ok) throw new Error(`CDN returned ${videoResp.status}`);
        const fileName = (title || 'video').replace(/[^a-zA-Z0-9\s]/g, '').trim() + '.' + (ext || 'mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', videoResp.headers.get('content-type') || 'video/mp4');
        videoResp.body.pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend running on port ${PORT}`));