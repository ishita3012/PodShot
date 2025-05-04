let startTime = null;
let endTime = null;

// Add a global status element for all messages
let globalStatus = document.createElement('div');
globalStatus.id = 'global-status';
globalStatus.style.color = 'red';
globalStatus.style.fontWeight = 'bold';
document.body.appendChild(globalStatus);

function isYouTubePage(url) {
  return url && url.includes('youtube.com/watch');
}

function isGoogleDoc(url) {
  return url && url.includes('docs.google.com/document');
}

function enableInsightsBtn(enabled = true) {
  const insightsBtn = document.getElementById('insightsBtn');
  if (insightsBtn) insightsBtn.disabled = !enabled;
}

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function setGlobalStatus(msg, color = 'red') {
  globalStatus.textContent = msg;
  globalStatus.style.color = color;
}

document.addEventListener('DOMContentLoaded', () => {
  const captureBtn = document.getElementById('captureBtn');
  const endBtn = document.getElementById('endBtn');
  const startTimeElement = document.getElementById('startTime');
  const endTimeElement = document.getElementById('endTime');
  const statusElement = document.getElementById('status');
  const clipInfoElement = document.getElementById('clipInfo');

  // Initialize the UI
  endBtn.disabled = true; // Keep "End Clip" button disabled initially
  clipInfoElement.style.display = 'none'; // Hide clip info initially
  
  // Set initial status message - displayed until user clicks Start Capturing
  var emoji = String.fromCodePoint(0x1F58B)
  statusElement.textContent = "Let's take notes!" + emoji;
  statusElement.style.fontFamily = '"Bradley Hand", cursive';
  statusElement.style.fontSize = '16px';
  
  captureBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!isYouTubePage(tab.url)) {
        setGlobalStatus('Please navigate to a YouTube video first', 'red');
        return;
      }
      
      // Get current timestamp whether it's the first time or an update
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getTimestamp' });
      
      if (!response || !response.success) {
        setGlobalStatus(response?.error || 'Could not get timestamp. Is the video playing?', 'red');
        return;
      }
      
      // Successfully got timestamp
      startTime = response.timestamp;
      startTimeElement.textContent = `Start: ${formatTime(startTime)}`;
      statusElement.textContent = 'Now capture the end timestamp';
      statusElement.style.fontFamily = '"Times New Roman", Times, serif';
      clipInfoElement.style.display = 'block';
      
      // Enable the End Clip button
      endBtn.disabled = false;
      endBtn.classList.remove('grey');
      endBtn.classList.add('purple');
      
      // Update caption for subsequent clicks
      captureBtn.innerHTML = 'Update<br>Start Time';
      
    } catch (error) {
      console.error('Error:', error);
      setGlobalStatus('Error: Please make sure the video is playing and try again', 'red');
    }
  });

  endBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!isYouTubePage(tab.url)) {
        setGlobalStatus('Please navigate to a YouTube video first', 'red');
        return;
      }
      
      if (!startTime) {
        setGlobalStatus('Please capture a start time first', 'red');
        return;
      }
      
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getTimestamp' });
      if (!response || !response.success) {
        setGlobalStatus(response?.error || 'Could not get timestamp. Is the video playing?', 'red');
        return;
      }
      
      endTime = response.timestamp;
      endTimeElement.textContent = `End: ${formatTime(endTime)}`;

      // Send clip information to background script
      console.log('Sending clip data to background script');
      chrome.runtime.sendMessage({
        action: 'saveClip',
        data: {
          videoUrl: tab.url,
          startTime,
          endTime,
          videoTitle: tab.title.replace(' - YouTube', '')
        }
      });

      setGlobalStatus('Processing clip...', 'green');
      
      // Reset state after a delay
      setTimeout(() => {
        startTime = null;
        endTime = null;
        statusElement.textContent = 'Ready to capture new clip';
        startTimeElement.textContent = '';
        endTimeElement.textContent = '';
        clipInfoElement.style.display = 'none';
        captureBtn.innerHTML = 'Start<br>Capturing';
        
        // Reset End Clip button to grey and disabled
        endBtn.disabled = true;
        endBtn.classList.remove('purple');
        endBtn.classList.add('grey');
        
        setGlobalStatus('', 'black');
      }, 2000);
    } catch (error) {
      console.error('Error saving clip:', error);
      setGlobalStatus('Error saving clip. Please try again.', 'red');
    }
  });
  
  // Add insights button handler
  const insightsBtn = document.getElementById('insightsBtn');
  insightsBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (isYouTubePage(tab.url)) {
      // First check if we've just saved a clip and are waiting for it to process
      if (document.getElementById('status').textContent === 'Ready to capture new clip') {
        setGlobalStatus('Generating insights from recent clip...', 'green');
        chrome.runtime.sendMessage({ action: 'generateInsights' });
        return;
      }
      
      // Check if we have a recent clip first by sending a message to the background script
      chrome.runtime.sendMessage({ action: 'checkRecentClip' }, (response) => {
        if (chrome.runtime.lastError) {
          setGlobalStatus('Error checking for recent clips', 'red');
          return;
        }
        
        if (response && response.hasRecentClip) {
          // We have a recent clip, proceed with generating insights
          setGlobalStatus('Generating insights...', 'green');
          chrome.runtime.sendMessage({ action: 'generateInsights' });
        } else {
          // No recent clip found
          setGlobalStatus('No recent clip found. Please save a clip first.', 'red');
        }
      });
    } else if (isGoogleDoc(tab.url)) {
      // Ask content script for selected text
      chrome.tabs.sendMessage(tab.id, { action: 'getSelectedText' }, (response) => {
        if (chrome.runtime.lastError) {
          setGlobalStatus('Please reload the Google Doc tab.', 'red');
          return;
        }
        const selectedText = response && response.selectedText;
        const docId = response && response.docId;
        if (selectedText && docId) {
          chrome.runtime.sendMessage({ action: 'generateInsightsForSelection', transcript: selectedText, docId });
        } else {
          setGlobalStatus('Please select transcript text in the doc.', 'red');
        }
      });
    } else {
      setGlobalStatus('Please open a YouTube or Google Docs page.', 'red');
    }
  });

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'processingStatus') {
      setGlobalStatus(message.status, message.isError ? 'red' : 'green');
    } else if (message.action === 'clipSuccess') {
      setGlobalStatus('Clip processed successfully!', 'green');
      statusElement.textContent = 'Ready to capture new clip';
    } else if (message.action === 'clipError') {
      setGlobalStatus(message.error || 'Error processing clip', 'red');
      statusElement.textContent = "Let's make notes!";
    } else if (message.action === 'insightsSuccess') {
      setGlobalStatus('Insights generated successfully!', 'green');
    } else if (message.action === 'insightsError') {
      setGlobalStatus(message.error || 'Error generating insights', 'red');
    }
  });

  // Only check if we're on YouTube (but don't get timestamp automatically)
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && !isYouTubePage(tab.url)) {
      setGlobalStatus('Please navigate to a YouTube video first', 'red');
      statusElement.textContent = "Let's make notes!";
    }
  });
});
