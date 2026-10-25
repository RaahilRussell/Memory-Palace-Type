export const sampleMemories = Array.from({ length: 29 }, (_, i) => ({
  id: i + 1, title: `Moment ${String(i + 1).padStart(2, '0')}`,
  url: `/images/memories/Pane%20${String(i + 1).padStart(2, '0')}.png`, generated: false,
}));

// Only same-origin media is loaded into the room's WebGL textures.
function mediaUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
export async function loadMemories() {
  if (new URLSearchParams(location.search).get('template') === '1') return { memories: sampleMemories, status: 'sample' };
  try {
    const response = await fetch('/api/memories', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!response.ok) throw new Error('Library unavailable');
    const data = await response.json();
    if (!Array.isArray(data.memories)) throw new Error('Invalid library');
    // The library's bundled CDN examples are not personal uploads. Keep the
    // supplied Figma room as the first-run template until real media is added.
    const library = data.memories.filter(memory => memory && memory.source !== 'demo');
    const memories = library.flatMap(memory => {
      const url = mediaUrl(memory.thumbnailUrl) || (memory.mediaType === 'image' && mediaUrl(memory.url));
      return typeof memory.id === 'string' && url ? [{
        id: memory.id, title: typeof memory.title === 'string' && memory.title.trim() ? memory.title : 'Untitled moment',
        url, generated: true,
      }] : [];
    });
    // Do not present a populated but unreadable library as an empty library.
    if (library.length && !memories.length) throw new Error('Library thumbnails unavailable');
    return { memories: memories.length ? memories : sampleMemories, status: memories.length ? 'ready' : 'sample' };
  } catch { return { memories: sampleMemories, status: 'offline' }; }
}
