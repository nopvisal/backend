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

// Write cookies from environment variable (only once at startup)
if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync('./cookies.txt', process.env.YOUTUBE_COOKIES);
    console.log('Cookies file written');
} else {
    console.warn('No YOUTUBE_COOKIES environment variable set – YouTube may fail');
}

// yt-dlp helper – always uses the cookie file
function ytDlp(args) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = './yt-dlp';
        const fullArgs = [
            '--js-runtime', 'node',
            '--cookies', './cookies.txt',
            ...args
        ];
        execFile(ytDlpPath, fullArgs, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout.trim());
        });
    });
}

// Cache for download URLs
const cache = new Map();

// Video info (YouTube + Facebook)
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

// Download URL
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

// TikTok endpoint
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
            downloadUrl: directUrl,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Proxy download – backend fetches the video and forces a file download
app.get('/api/proxy-download', async (req, res) => {
    const { url, title, ext } = req.query;
    if (!url) return res.status(400).send('Missing URL');

    try {
        // Fetch the video from the CDN (server-to-server, no CORS issues)
        const videoResponse = await fetch(url);
        if (!videoResponse.ok) throw new Error(`CDN returned ${videoResponse.status}`);

        // Set headers to force download
        const fileName = (title || 'video').replace(/[^a-zA-Z0-9\s]/g, '').trim() + '.' + (ext || 'mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', videoResponse.headers.get('content-type') || 'video/mp4');

        // Pipe the video data to the client
        videoResponse.body.pipe(res);
    } catch (err) {
        console.error('Proxy download error:', err);
        res.status(500).json({ error: err.message });
    }
});
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Backend running on port ${PORT}`);
});