function findYouTubeVideo() {
  // Try different selectors for YouTube video
  const selectors = [
    'video.html5-main-video',
    'video.video-stream',
    '#movie_player video',
    '.html5-video-container video',
    'video'  // fallback to any video element
  ];

  for (const selector of selectors) {
    const video = document.querySelector(selector);
    if (video && !isNaN(video.duration)) {
      console.log('Found video with selector:', selector);
      return video;
    }
  }

  console.log('No video element found. Available video elements:', document.querySelectorAll('video').length);
  return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getTimestamp') {
    const video = findYouTubeVideo();
    if (video) {
      sendResponse({ 
        timestamp: video.currentTime,
        success: true
      });
    } else {
      console.log('No valid video element found');
      sendResponse({ 
        error: 'No video element found. Make sure you are on a video page and the video has loaded.',
        success: false
      });
    }
  } else if (request.action === 'getSelectedText') {
    try {
      // Get selected text in Google Docs
      const docId = window.location.href.match(/\/document\/d\/([\w-]+)/)?.[1];
      const selectedText = window.getSelection().toString();
      
      sendResponse({
        selectedText: selectedText,
        docId: docId,
        success: true
      });
    } catch (error) {
      console.error('Error getting selected text:', error);
      sendResponse({
        error: 'Could not get selected text',
        success: false
      });
    }
  }
  return true;
});
