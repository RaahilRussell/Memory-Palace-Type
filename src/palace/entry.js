// Preserve existing OAuth callbacks, shared-room links, and bookmarks at the old root URL.
const params = new URLSearchParams(location.search);
if (['google', 'photos', 'onboarding', 'room', 'memory', 'import', 'invite'].some(key => params.has(key))) {
  location.replace(`/library/${location.search}${location.hash}`);
}
