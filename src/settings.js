document.addEventListener('DOMContentLoaded', () => {
  // Load saved settings
  chrome.storage.sync.get('openaiKey', (data) => {
    if (data.openaiKey) {
      document.getElementById('openaiKey').value = data.openaiKey;
    }
  });

  // Save settings
  document.getElementById('save').addEventListener('click', () => {
    const openaiKey = document.getElementById('openaiKey').value.trim();
    const status = document.getElementById('status');

    if (!openaiKey) {
      status.textContent = 'Please enter an OpenAI API key';
      status.className = 'error';
      return;
    }

    chrome.storage.sync.set({ openaiKey }, () => {
      status.textContent = 'Settings saved successfully!';
      status.className = 'success';
      setTimeout(() => {
        status.textContent = '';
        status.className = '';
      }, 3000);
    });
  });
});
