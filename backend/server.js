const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => res.send('MediaForge backend is running'));

// ---------- Fetch helper with timeout ----------
function fetchWithTimeout(url, options = {}, timeout = 6000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        fetch(url, { ...options, signal: controller.signal })
            .then(res => { clearTimeout(timer); resolve(res); })
            .catch(err => { clearTimeout(timer); reject(err); });
    });
}

// ---------- Try a single API and return { title, thumbnail, downloadUrl } or null ----------
async function tryAPI(url, apiName, fetcher) {
    try {
        console.log(`Trying ${apiName}...`);
        return await fetcher(url);
    } catch (e) {
        console.warn(`${apiName} failed:`, e.message);
        return null;
    }
}

// ---------- API 1: lucash.dev ----------
async function lucashDev(url) {
    const apiUrl = `https://api.lucash.dev/video?url=${encodeURIComponent(url)}`;
    const resp = await fetchWithTimeout(apiUrl);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.error || !data.download_url) return null;
    return {
        title: data.title || 'YouTube Video',
        thumbnail: data.thumbnail || '',
        downloadUrl: data.download_url,
    };
}

// ---------- API 2: y2mate (free, no key) ----------
async function y2mate(url) {
    // y2mate requires getting an ID first, then the download URL.
    // But there's a simpler direct API endpoint on some mirrors.
    const apiUrl = `https://api.y2mate.com/api/convert`;
    const body = new URLSearchParams();
    body.append('url', url);
    body.append('format', 'mp4');
    body.append('quality', '720p');
    const resp = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.download_url) return null;
    return {
        title: data.title || 'YouTube Video',
        thumbnail: data.thumbnail || '',
        downloadUrl: data.download_url,
    };
}

// ---------- API 3: vevioz (with improved headers) ----------
async function vevioz(url) {
    const apiUrl = `https://api.vevioz.com/@api/button/mp4/${extractYouTubeID(url)}`;
    const resp = await fetchWithTimeout(apiUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.url) return null;
    return {
        title: data.title || 'YouTube Video',
        thumbnail: `https://img.youtube.com/vi/${extractYouTubeID(url)}/hqdefault.jpg`,
        downloadUrl: data.url,
    };
}

// ---------- API 4: loader.to ----------
async function loaderTo(url) {
    const apiUrl = `https://loader.to/api/card/?url=${encodeURIComponent(url)}`;
    const resp = await fetchWithTimeout(apiUrl);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.download_url) return null;
    return {
        title: data.title || 'YouTube Video',
        thumbnail: data.thumbnail || '',
        downloadUrl: data.download_url,
    };
}

// Helper to extract YouTube video ID
function extractYouTubeID(url) {
    const match = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:&|$|\/|\.)/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : '';
}

// ---------- YouTube endpoint ----------
app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Cascade of APIs (order matters – fastest first)
    const apis = [
        { name: 'lucash.dev', fn: lucashDev },
        { name: 'y2mate', fn: y2mate },
        { name: 'vevioz', fn: vevioz },
        { name: 'loader.to', fn: loaderTo },
    ];

    for (const api of apis) {
        const result = await tryAPI(url, api.name, api.fn);
        if (result) return res.json(result);
    }

    res.status(500).json({ error: 'All YouTube APIs failed. Please try again later.' });
});

// ---------- TikTok (unchanged) ----------
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

// ---------- Facebook placeholder (if needed, can be added later) ----------
app.get('/api/facebook', async (req, res) => {
    res.status(500).json({ error: 'Facebook not supported yet' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend running on port ${PORT}`));