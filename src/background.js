// Store documents mapping
let docsMapping = {};

// Load existing mappings
chrome.storage.sync.get('docsMapping', (result) => {
  if (result.docsMapping) {
    docsMapping = result.docsMapping;
    console.log("DEBUG: Loaded existing docs mapping:", docsMapping);
  }
});

// Keep track of clip processing state
let clipProcessingInfo = {
  inProgress: false,
  docId: null,
  videoId: null
};

// Keep track of the most recent clip data
let lastClipInfo = {
  docId: null,
  transcript: null
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Received message:', request);
  if (request.action === 'saveClip') {
    console.log('Processing saveClip action with data:', request.data);
    handleClipSave(request.data);
  }
  if (request.action === 'generateInsights') {
    console.log('Processing generateInsights action');
    generateInsightsForLatestClip();
  }
  if (request.action === 'checkRecentClip') {
    console.log('Checking for recent clip');
    // Check for clips that have finished processing
    const hasFinishedClip = !!(lastClipInfo.docId && lastClipInfo.transcript);
    
    // Also check for clips that are still processing
    const hasProcessingClip = clipProcessingInfo.inProgress;
    
    console.log('Has finished clip:', hasFinishedClip, 'Has processing clip:', hasProcessingClip);
    sendResponse({ 
      hasRecentClip: hasFinishedClip || hasProcessingClip,
      isProcessing: hasProcessingClip
    });
    return true; // Keep the messaging channel open for the async response
  }
  return true; // Important: keeps the message channel open for async response
});

async function getAuthToken() {
  console.log("DEBUG: Getting auth token");
  try {
    return await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
          console.error("DEBUG: Auth error:", chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
        } else {
          console.log("DEBUG: Got auth token successfully");
          resolve(token);
        }
      });
    });
  } catch (error) {
    console.error("DEBUG: Failed to get auth token:", error);
    throw new Error("Authentication failed. Please check your Google account permissions.");
  }
}

async function handleClipSave(clipData) {
  try {
    console.log("DEBUG: Starting handleClipSave");
    
    // Get auth token first to fail early if there are auth issues
    const token = await getAuthToken();
    
    // Clean the title to create only one doc per video
    const videoId = new URL(clipData.videoUrl).searchParams.get('v');
    if (!videoId) {
      throw new Error("Could not extract video ID from URL");
    }
    
    const cleanTitle = clipData.videoTitle.replace(' - YouTube', '');
    
    // Use video ID as part of the key for more reliable mapping
    const docKey = `${videoId}_${cleanTitle}`;
    console.log("DEBUG: Doc key:", docKey);
    
    // Get or create document
    const docId = await getOrCreateDoc(docKey, cleanTitle);
    console.log("DEBUG: Got document ID:", docId);
    
    // Track that clip processing is in progress
    clipProcessingInfo = {
      inProgress: true,
      docId: docId,
      videoId: videoId
    };
    
    // Skip initial link at the top when we already have a document
    if (!docsMapping[docKey]) {
      // Use the appendClipLink function for proper link formatting
      await appendClipLink(docId, clipData);
    }
    
    // Process clip with backend
    try {
      console.log("DEBUG: Processing clip with backend");
      const backendUrl = 'http://localhost:8000';
      
      // Log the exact request being sent
      const requestBody = {
        video_url: clipData.videoUrl,
        start_time: clipData.startTime,
        end_time: clipData.endTime
      };
      console.log("DEBUG: Request to backend:", JSON.stringify(requestBody));
      
      const response = await fetch(`${backendUrl}/process-clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text(); 
        console.error("DEBUG: Backend error:", response.status, errorText);
        throw new Error(`Backend error: ${errorText || response.status}`);
      }
      
      const data = await response.json();
      console.log("DEBUG: Got response from backend:", JSON.stringify(data));
      
      if (!data.task_id) {
        console.error("DEBUG: No task_id in response:", data);
        throw new Error("Backend did not return a task_id");
      }
      
      // Safely send messages to popup, handling case where popup is closed
      function safelySendMessage(message) {
        try {
          // First check if there are any popup tabs to receive the message
          chrome.runtime.sendMessage(message, response => {
            if (chrome.runtime.lastError) {
              // Suppress the error - this happens when popup is closed
              console.log("DEBUG: Popup closed, couldn't send message");
            }
          });
        } catch (error) {
          console.log("DEBUG: Error sending message to popup:", error);
        }
      }

      // Update popup status
      safelySendMessage({ 
        action: 'clipStatus', 
        status: 'Processing clip... this may take a minute',
        showSpinner: true
      });
      
      // Poll the status endpoint until processing is complete
      const taskId = data.task_id;
      let transcript = null;
      let attempts = 0;
      const maxAttempts = 30; // 30 x 2s = 60 seconds max wait time
      
      while (attempts < maxAttempts) {
        console.log(`DEBUG: Checking status, attempt ${attempts + 1}/${maxAttempts}`);
        
        const statusResponse = await fetch(`${backendUrl}/status/${taskId}`);
        if (!statusResponse.ok) {
          console.error("DEBUG: Status check error:", await statusResponse.text());
          attempts++;
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
          continue;
        }
        
        const statusData = await statusResponse.json();
        console.log("DEBUG: Status update:", statusData);
        
        // Update popup with processing status
        safelySendMessage({ 
          action: 'clipStatus', 
          status: statusData.message || `Processing (${statusData.status})`,
          showSpinner: true
        });
        
        if (statusData.status === "completed") {
          transcript = statusData.transcript;
          // Store the transcript and docId for later insights generation
          lastClipInfo = {
            docId: docId,
            transcript: transcript
          };
          console.log("DEBUG: Saved transcript data for insights generation:", lastClipInfo.docId);
          
          // Reset processing state as soon as we have the transcript
          clipProcessingInfo.inProgress = false;
          break;
        } else if (statusData.status === "error") {
          throw new Error(statusData.message || "Processing failed");
        }
        
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      }
      
      if (!transcript) {
        throw new Error("Timed out waiting for transcript or processing failed");
      }
      
      console.log("DEBUG: Processing complete, got transcript");
      
      // Format URL with timestamp 
      const timestampedUrl = `${clipData.videoUrl}&t=${Math.floor(clipData.startTime)}`;
      
      // Add transcript with a clickable link before it
      console.log("DEBUG: Adding transcript with link to doc");
      await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                endOfSegmentLocation: {},
                text: "\n\nClick here to watch the clip\n"
              }
            }
          ]
        })
      });
      
      // Make sure all of "Click here to watch the clip" is hyperlinked
      await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      .then(response => response.json())
      .then(async docContent => {
        // Find the last occurrence of the link text
        let lastPos = -1;
        let pos = 0;
        
        for (const item of docContent.body.content || []) {
          if (item.paragraph && item.paragraph.elements) {
            for (const element of item.paragraph.elements) {
              if (element.textRun && element.textRun.content) {
                const text = element.textRun.content;
                const idx = text.lastIndexOf("Click here to watch the clip");
                if (idx !== -1) {
                  lastPos = pos + idx;
                }
                pos += text.length;
              }
            }
          }
        }
        
        if (lastPos !== -1) {
          await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              requests: [
                {
                  updateTextStyle: {
                    range: {
                      startIndex: lastPos,
                      endIndex: lastPos + 29 // Include the full "Click here to watch the clip" phrase (29 chars total)
                    },
                    textStyle: {
                      link: { url: timestampedUrl },
                      foregroundColor: {
                        color: {
                          rgbColor: {
                            blue: 0.8,
                            red: 0.0,
                            green: 0.3
                          }
                        }
                      },
                      underline: true
                    },
                    fields: "link,foregroundColor,underline"
                  }
                }
              ]
            })
          });
        }
      });
      
      // Now add the transcript after the link with proper spacing
      await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                endOfSegmentLocation: {},
                text: "\nTranscript:\n" + transcript + "\n"
              }
            }
          ]
        })
      });
      
      // Make "Transcript:" bold
      await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      .then(response => response.json())
      .then(async docContent => {
        // Find the last occurrence of "Transcript:"
        let lastPos = -1;
        let pos = 0;
        
        for (const item of docContent.body.content || []) {
          if (item.paragraph && item.paragraph.elements) {
            for (const element of item.paragraph.elements) {
              if (element.textRun && element.textRun.content) {
                const text = element.textRun.content;
                const idx = text.lastIndexOf("Transcript:");
                if (idx !== -1) {
                  lastPos = pos + idx;
                }
                pos += text.length;
              }
            }
          }
        }
        
        if (lastPos !== -1) {
          await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              requests: [
                {
                  updateTextStyle: {
                    range: {
                      startIndex: lastPos,
                      endIndex: lastPos + 11 // "Transcript:" is 11 chars
                    },
                    textStyle: {
                      bold: true
                    },
                    fields: "bold"
                  }
                }
              ]
            })
          });
        }
      });
      
      // Make sure any standalone "clip" word is also hyperlinked
      await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      .then(response => response.json())
      .then(async docContent => {
        // Find any standalone "clip" word
        let pos = 0;
        let clipPositions = [];
        
        for (const item of docContent.body.content || []) {
          if (item.paragraph && item.paragraph.elements) {
            for (const element of item.paragraph.elements) {
              if (element.textRun && element.textRun.content) {
                const text = element.textRun.content;
                // Look for " clip " with word boundaries
                let start = 0;
                let foundPos;
                while ((foundPos = text.indexOf(" clip", start)) !== -1) {
                  // Check if it's a standalone word
                  if (foundPos + 5 >= text.length || text[foundPos + 5] === ' ' || text[foundPos + 5] === '\n') {
                    clipPositions.push(pos + foundPos + 1); // +1 to skip the space
                  }
                  start = foundPos + 5;
                }
                pos += text.length;
              }
            }
          }
        }
        
        // Hyperlink each standalone "clip" word
        for (const clipPos of clipPositions) {
          await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              requests: [
                {
                  updateTextStyle: {
                    range: {
                      startIndex: clipPos,
                      endIndex: clipPos + 5 // Include the full "clip" word (5 chars total)
                    },
                    textStyle: {
                      link: { url: timestampedUrl },
                      foregroundColor: {
                        color: {
                          rgbColor: {
                            blue: 0.8,
                            red: 0.0,
                            green: 0.3
                          }
                        }
                      },
                      underline: true
                    },
                    fields: "link,foregroundColor,underline"
                  }
                }
              ]
            })
          });
        }
      });
      
      // Tell the popup we succeeded
      safelySendMessage({ 
        action: 'clipSuccess', 
        docId: docId 
      });
    } catch (error) {
      // Reset processing state on error
      clipProcessingInfo.inProgress = false;
      
      console.error("DEBUG: Error processing clip:", error);
      chrome.runtime.sendMessage({ 
        action: 'clipError', 
        error: 'Failed to process clip: ' + error.message 
      });
    }
  } catch (error) {
    console.error("DEBUG: Top-level error:", error);
    chrome.runtime.sendMessage({ 
      action: 'clipError', 
      error: 'Failed to process clip: ' + error.message 
    });
  }
}

async function getOrCreateDoc(docKey, videoTitle) {
  try {
    // Check if we already have a doc for this video
    if (docsMapping[docKey]) {
      console.log("DEBUG: Found existing doc:", docKey, docsMapping[docKey]);
      return docsMapping[docKey];
    }

    // Create new doc
    const docId = await createNewDoc(videoTitle);
    console.log("DEBUG: Created new doc:", docId, "for", videoTitle);
    
    // Store mapping with the docKey (based on video ID)
    docsMapping[docKey] = docId;
    
    // Save to persistent storage
    chrome.storage.sync.set({ docsMapping }, () => {
      console.log("DEBUG: Updated doc mapping saved to storage");
    });
    
    return docId;
  } catch (error) {
    console.error('Error in getOrCreateDoc:', error);
    throw error;
  }
}

async function createNewDoc(title) {
  try {
    console.log("DEBUG: Creating new doc with title:", title);
    const token = await getAuthToken();
    
    // Create a document with title + "YouTube"
    const response = await fetch('https://docs.googleapis.com/v1/documents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title: `${title} - YouTube` })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("DEBUG: Document creation failed:", response.status, errorText);
      throw new Error(`Failed to create document: ${response.status}`);
    }
    
    const data = await response.json();
    console.log("DEBUG: Document created successfully:", data.documentId);
    
    // Add the "Notes" header centered at the top with Arial font
    await fetch(`https://docs.googleapis.com/v1/documents/${data.documentId}:batchUpdate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: "Notes\n\n"
            }
          },
          {
            updateParagraphStyle: {
              range: {
                startIndex: 1,
                endIndex: 6
              },
              paragraphStyle: {
                alignment: "CENTER",
                namedStyleType: "NORMAL_TEXT"
              },
              fields: "alignment,namedStyleType"
            }
          },
          {
            updateTextStyle: {
              range: {
                startIndex: 1,
                endIndex: 6
              },
              textStyle: {
                weightedFontFamily: {
                  fontFamily: "Arial"
                },
                fontSize: {
                  magnitude: 26,
                  unit: "PT"
                },
                bold: true
              },
              fields: "weightedFontFamily,fontSize,bold"
            }
          }
        ]
      })
    });
    
    return data.documentId;
  } catch (error) {
    console.error("DEBUG: Document creation error:", error);
    throw error;
  }
}

// Formats the timestamp link text for any "click here" or "clip" links
function formatLinkForDoc(docId, linkText, url, token) {
  return fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  })
  .then(response => response.json())
  .then(docContent => {
    // Find the text in the document
    const content = docContent.body.content || [];
    let foundPosition = -1;
    let currentPosition = 0;
    
    // Search through all paragraphs to find text
    for (const item of content) {
      if (item.paragraph && item.paragraph.elements) {
        for (const element of item.paragraph.elements) {
          if (element.textRun && element.textRun.content) {
            const text = element.textRun.content;
            const pos = text.lastIndexOf(linkText);
            if (pos !== -1) {
              foundPosition = currentPosition + pos;
            }
            currentPosition += text.length;
          }
        }
        if (foundPosition !== -1) break;
      }
    }
    
    // Apply link formatting if found
    if (foundPosition !== -1) {
      return fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              updateTextStyle: {
                range: {
                  startIndex: foundPosition,
                  endIndex: foundPosition + linkText.length
                },
                textStyle: {
                  link: { url: url },
                  foregroundColor: {
                    color: {
                      rgbColor: {
                        blue: 0.8,
                        red: 0.0,
                        green: 0.3
                      }
                    }
                  },
                  underline: true
                },
                fields: "link,foregroundColor,underline"
              }
            }
          ]
        })
      });
    }
    
    return Promise.resolve();
  });
}

// Fixes problem with "Click here to watch clip" link formatting
// This ensures we add proper link after the Notes heading
async function appendClipLink(docId, clipData) {
  try {
    const token = await getAuthToken();
    const timestampedUrl = `${clipData.videoUrl}&t=${Math.floor(clipData.startTime)}`;
    
    // First add the text with line breaks
    await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              endOfSegmentLocation: {},
              text: `Click here to watch the clip\nStart Time: ${formatTime(clipData.startTime)}\nEnd Time: ${formatTime(clipData.endTime)}\n\n---\n`
            }
          }
        ]
      })
    });
    
    // Get the document to find the link position
    const docResponse = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const docContent = await docResponse.json();
    const content = docContent.body.content || [];
    
    // Find where "Click here to watch the clip" is located
    let linkTextPos = -1;
    let contentIndex = 0;
    
    // Search through all paragraphs until we find our link text
    for (const item of content) {
      if (item.paragraph && item.paragraph.elements) {
        for (const element of item.paragraph.elements) {
          if (element.textRun && element.textRun.content) {
            const text = element.textRun.content;
            if (text.includes("Click here to watch the clip")) {
              linkTextPos = contentIndex;
              break;
            }
            contentIndex += text.length;
          }
        }
        if (linkTextPos !== -1) break;
      }
    }
    
    // If we found the link text, apply formatting
    if (linkTextPos !== -1) {
      await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              updateTextStyle: {
                range: {
                  startIndex: linkTextPos,
                  endIndex: linkTextPos + 24 // "Click here to watch the clip" is 24 chars
                },
                textStyle: {
                  link: { url: timestampedUrl },
                  foregroundColor: {
                    color: {
                      rgbColor: {
                        blue: 0.8,
                        red: 0.0,
                        green: 0.3
                      }
                    }
                  },
                  underline: true
                },
                fields: "link,foregroundColor,underline"
              }
            }
          ]
        })
      });
    }
    
    return true;
  } catch (error) {
    console.error("DEBUG: Error adding clip link:", error);
    throw error;
  }
}

function formatTime(seconds) {
  const date = new Date(seconds * 1000);
  const hh = date.getUTCHours().toString().padStart(2, '0');
  const mm = date.getUTCMinutes().toString().padStart(2, '0');
  const ss = date.getUTCSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// Helper function to consistently clean video titles
function cleanVideoTitle(title) {
  // Remove " - YouTube" suffix
  title = title.replace(/ - YouTube$/, '');
  
  // Remove any special characters that might cause problems
  title = title.replace(/[^\w\s-]/g, '');
  
  // Trim whitespace
  title = title.trim();
  
  console.log("DEBUG: Cleaned video title:", title);
  return title;
}

async function generateInsightsForLatestClip() {
  try {
    // Check if a clip is currently being processed
    if (clipProcessingInfo.inProgress) {
      console.log("Clip is still being processed. Will use the current document when done.");
      
      // Notify popup that we're waiting for clip processing
      try {
        chrome.runtime.sendMessage({ 
          action: 'processingStatus', 
          status: 'Waiting for clip processing to complete before generating insights...', 
          isError: false 
        });
      } catch (error) {
        console.log("Error sending message to popup:", error);
      }
      
      // Wait for the processing to finish (up to 60 seconds)
      let attempts = 0;
      const maxAttempts = 30; // 30 x 2s = 60 seconds max wait time
      
      while (attempts < maxAttempts) {
        console.log(`DEBUG: Waiting for transcript, attempt ${attempts + 1}/${maxAttempts}`);
        
        // Check if we have transcript data
        if (lastClipInfo.docId && lastClipInfo.transcript) {
          console.log("DEBUG: Transcript is available, proceeding with insights generation");
          break;
        }
        
        // Check if processing has completed
        if (!clipProcessingInfo.inProgress) {
          console.log("DEBUG: Clip processing has finished");
          // Wait one more second to ensure transcript is available
          await new Promise(resolve => setTimeout(resolve, 1000));
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        attempts++;
      }
    }
    
    // Double-check we have clip data after potentially waiting
    if (!lastClipInfo.docId || !lastClipInfo.transcript) {
      console.error("No recent clip to generate insights for after waiting");
      try {
        chrome.runtime.sendMessage({ 
          action: 'processingStatus', 
          status: 'No recent clip data found after waiting. Please try saving the clip again.', 
          isError: true 
        });
      } catch (error) {
        console.log("Error sending message to popup:", error);
      }
      return;
    }

    // Create local copies of the data to prevent race conditions
    const docId = lastClipInfo.docId;
    const transcript = lastClipInfo.transcript;
    
    if (!docId || !transcript) {
      console.error("Missing required clip data");
      try {
        chrome.runtime.sendMessage({ 
          action: 'processingStatus', 
          status: 'Missing required clip data. Please try again.', 
          isError: true 
        });
      } catch (error) {
        console.log("Error sending message to popup:", error);
      }
      return;
    }

    const token = await getAuthToken();
    const backendUrl = 'http://localhost:8000';
    
    // Notify popup if active
    try {
      chrome.runtime.sendMessage({ 
        action: 'processingStatus', 
        status: 'Generating insights...', 
        isError: false 
      });
    } catch (error) {
      console.log("Error sending message to popup:", error);
    }
    
    console.log('Generated insights request body:', JSON.stringify({ transcript: transcript }));
    
    console.log('Generating insights for transcript:', transcript.substring(0, 100) + '...');
    
    // Generate insights from backend
    const response = await fetch(`${backendUrl}/generate-insights`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transcript: transcript })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Backend error response:', response.status, errorText);
      throw new Error(`Backend error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    const insights = data.insights;
    
    if (!insights) {
      throw new Error('No insights returned from backend');
    }
    
    console.log('Generated insights:', insights);
    
    // Add insights to the document
    await addInsightsToDocument(docId, insights, token);
    
    // Notify popup if active
    try {
      chrome.runtime.sendMessage({ 
        action: 'insightsSuccess', 
        status: 'Insights added to document!', 
        isError: false 
      });
    } catch (error) {
      console.log("Error sending message to popup:", error);
    }
    
  } catch (error) {
    console.error("Error generating insights:", error);
    
    try {
      chrome.runtime.sendMessage({ 
        action: 'insightsError', 
        status: `Error generating insights: ${error.message}`, 
        isError: true 
      });
    } catch (msgError) {
      console.log("Error sending message to popup:", msgError);
    }
  }
}

async function addInsightsToDocument(docId, insights, token) {
  // Remove "Key Insights:" from the insights text if present
  insights = insights.replace(/^Key Insights:\s*/i, "");
  
  // Add the insights text
  await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        {
          insertText: {
            endOfSegmentLocation: {},
            text: "\nInsights:\n" + insights + "\n"
          }
        }
      ]
    })
  });
  
  // Make "Insights:" bold
  await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  })
  .then(response => response.json())
  .then(async docContent => {
    // Find the last occurrence of "Insights:"
    let lastPos = -1;
    let pos = 0;
    
    for (const item of docContent.body.content || []) {
      if (item.paragraph && item.paragraph.elements) {
        for (const element of item.paragraph.elements) {
          if (element.textRun && element.textRun.content) {
            const text = element.textRun.content;
            const idx = text.lastIndexOf("Insights:");
            if (idx !== -1) {
              lastPos = pos + idx;
            }
            pos += text.length;
          }
        }
      }
    }
    
    if (lastPos !== -1) {
      await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              updateTextStyle: {
                range: {
                  startIndex: lastPos,
                  endIndex: lastPos + 9 // "Insights:" is 9 chars
                },
                textStyle: {
                  bold: true
                },
                fields: "bold"
              }
            }
          ]
        })
      });
    }
  });
}
