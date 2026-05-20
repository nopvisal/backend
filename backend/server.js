const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => res.send('MediaForge backend is running'));

// ---------- yt-dlp as spawn (streaming) ----------
function streamYtDlp(args, res) {
    const ytDlpPath = './yt-dlp';
    const fullArgs = [
        '--no-warnings', '--no-playlist',
        '--socket-timeout', '30',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '--extractor-args', 'youtube:player_client=android',
    ];

    if (process.env.YTDLP_PROXY) {
        fullArgs.push('--proxy', process.env.YTDLP_PROXY);
    }
    if (fs.existsSync('./cookies.txt')) {
        fullArgs.push('--cookies', './cookies.txt');
    }

    fullArgs.push(...args);

    const proc = spawn(ytDlpPath, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.pipe(res);      // stream the video directly to the browser

    proc.stderr.on('data', (data) => {
        console.error(`yt-dlp stderr: ${data}`);
    });

    proc.on('error', (err) => {
        console.error('yt-dlp spawn error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    });

    proc.on('close', (code) => {
        if (code !== 0 && !res.headersSent) {
            res.status(500).json({ error: 'yt-dlp exited with code ' + code });
        }
    });
}

// ---------- YouTube info ----------
app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const proc = spawn('./yt-dlp', [
            '--dump-single-json', '--no-playlist', url,
            ...(process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : []),
            ...(fs.existsSync('./cookies.txt') ? ['--cookies', './cookies.txt'] : []),
        ]);
        let output = '';
        proc.stdout.on('data', (data) => output += data);
        await new Promise((resolve, reject) => {
            proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('yt-dlp error')));
            proc.on('error', reject);
        });
        const info = JSON.parse(output);
        const formats = (info.formats || [])
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
            .sort((a, b) => (b.height || 0) - (a.height || 0));
        if (formats.length === 0) throw new Error('No downloadable format');
        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration_string,
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
        const resp = await fetch(apiUrl);
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
        const proc = spawn('./yt-dlp', [
            '--dump-single-json', '--no-playlist', url,
            ...(process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : []),
            ...(fs.existsSync('./cookies.txt') ? ['--cookies', './cookies.txt'] : []),
        ]);
        let output = '';
        proc.stdout.on('data', (data) => output += data);
        await new Promise((resolve, reject) => {
            proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('yt-dlp error')));
            proc.on('error', reject);
        });
        const info = JSON.parse(output);
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

// ---------- Download endpoint (streams video via yt-dlp) ----------
app.get('/api/download-video', (req, res) => {
    const { url, formatId, title, ext } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const fileName = (title || 'video').replace(/[^a-zA-Z0-9\s]/g, '').trim() + '.' + (ext || 'mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    // yt-dlp arguments: output to stdout
    const args = ['-f', formatId || 'best', '-o', '-', url];
    streamYtDlp(args, res);
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend running on port ${PORT}`));