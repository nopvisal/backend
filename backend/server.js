const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ==================== YT-DLP HELPER ====================
function ytDlp(args) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        execFile(ytDlpPath, args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout.trim());
        });
    });
}

// ==================== YOUTUBE / FACEBOOK ====================
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

        res.json({
            title: info.title,
            thumbnail,
            duration: info.duration_string || `${Math.floor(info.duration || 0)}s`,
            formatId,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const cache = new Map();
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

// ==================== TIKTOK (via tikwm.com) ====================
app.get('/api/tiktok', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.code !== 0 || !data.data) {
            throw new Error(data.msg || 'TikTok API error');
        }

        const videoData = data.data;
        const directUrl = videoData.hdplay || videoData.play || videoData.wmplay;
        if (!directUrl) throw new Error('No video URL found');

        res.json({
            title: videoData.title || 'TikTok Video',
            thumbnail: videoData.cover || '',
            duration: videoData.duration || 'Unknown',
            author: videoData.author?.nickname || '',
            downloadUrl: directUrl,
        });
    } catch (err) {
        // Fallback: try another API if tikwm fails
        try {
            const fallbackUrl = `https://api.tikmate.app/api?url=${encodeURIComponent(url)}`;
            const resp2 = await fetch(fallbackUrl);
            const data2 = await resp2.json();
            if (data2 && data2.video_url) {
                res.json({
                    title: data2.title || 'TikTok Video',
                    thumbnail: data2.thumbnail || '',
                    duration: 'Unknown',
                    author: data2.author_name || '',
                    downloadUrl: data2.video_url,
                });
                return;
            }
        } catch (e2) {
            console.error('Fallback also failed:', e2.message);
        }
        res.status(500).json({ error: 'Failed to get TikTok video: ' + err.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Backend running at http://localhost:${PORT}`);
});