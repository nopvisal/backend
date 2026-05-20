const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => res.send('MediaForge backend is running'));

// ---------- yt-dlp helper ----------
function ytDlp(args) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = './yt-dlp';
        const fullArgs = [
            '--no-warnings', '--no-playlist',
            '--socket-timeout', '30',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            '--extractor-args', 'youtube:player_client=android',
        ];

        // Use proxy if available (from environment variable)
        if (process.env.YTDLP_PROXY) {
            fullArgs.push('--proxy', process.env.YTDLP_PROXY);
        }

        // Use cookies if file exists (optional)
        if (fs.existsSync('./cookies.txt')) {
            fullArgs.push('--cookies', './cookies.txt');
        }

        fullArgs.push(...args);

        execFile(ytDlpPath, fullArgs, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout.trim());
        });
    });
}

// ---------- Fetch helper with timeout ----------
function fetchWithTimeout(url, options = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        fetch(url, { ...options, signal: controller.signal })
            .then(res => { clearTimeout(timer); resolve(res); })
            .catch(err => { clearTimeout(timer); reject(err); });
    });
}

// ---------- YouTube info ----------
app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const json = await ytDlp(['--dump-single-json', url]);
        const info = JSON.parse(json);
        const formats = (info.formats || [])
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
            .sort((a, b) => (b.height || 0) - (a.height || 0));
        if (formats.length === 0) throw new Error('No downloadable format');
        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration_string,
            quality: formats[0].height ? `${formats[0].height}p` : 'Unknown',
            formatId: formats[0].format_id,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- TikTok info ----------
app.get('/api/tiktok', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const resp = await fetchWithTimeout(apiUrl);
        const data = await resp.json();
        if (data.code !== 0 || !data.data) throw new Error(data.msg || 'TikTok API error');
        const v = data.data;
        res.json({
            title: v.title || 'TikTok Video',
            thumbnail: v.cover || '',
            duration: v.duration || 'Unknown',
            author: v.author?.nickname || '',
            directUrl: v.hdplay || v.play || v.wmplay,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Facebook info ----------
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

// ---------- DOWNLOAD ENDPOINT (yt-dlp downloads and streams) ----------
app.get('/api/download-video', async (req, res) => {
    const { url, formatId, title, ext } = req.query;
    if (!url) return res.status(400).send('Missing URL');

    const tmpFileName = `/tmp/mediaforge_${Date.now()}.${ext || 'mp4'}`;
    const args = ['-f', formatId || 'best', '-o', tmpFileName, '--no-playlist', url];

    try {
        // Download the video using yt-dlp
        await ytDlp(args);

        // Check if file exists
        if (!fs.existsSync(tmpFileName)) throw new Error('Download failed – no file produced');

        const fileSize = fs.statSync(tmpFileName).size;
        const fileName = (title || 'video').replace(/[^a-zA-Z0-9\s]/g, '').trim() + '.' + (ext || 'mp4');

        // Set headers to force download
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
        res.setHeader('Content-Length', fileSize);

        // Stream the file to the client
        const readStream = fs.createReadStream(tmpFileName);
        readStream.pipe(res);

        // Clean up temp file after stream finishes
        readStream.on('end', () => {
            fs.unlink(tmpFileName, () => {});
        });
        readStream.on('error', () => {
            fs.unlink(tmpFileName, () => {});
        });
    } catch (err) {
        console.error(err);
        // Clean up temp file if exists
        if (fs.existsSync(tmpFileName)) fs.unlink(tmpFileName, () => {});
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend running on port ${PORT}`));