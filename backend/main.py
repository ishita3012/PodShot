from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Form, BackgroundTasks
from pydantic import BaseModel
import yt_dlp
import ffmpeg
import tempfile
import os
import subprocess
import uuid
from typing import Optional
from fastapi.responses import JSONResponse
import openai
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Use new OpenAI client for >=1.0.0
print("OPENAI_API_KEY loaded:", os.getenv("OPENAI_API_KEY"))
client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Storage for background tasks
processing_status = {}

class TranscribeRequest(BaseModel):
    video_url: str
    start_time: float  # in seconds
    end_time: float    # in seconds

class TranscribeFullRequest(BaseModel):
    video_url: str

class InsightsRequest(BaseModel):
    transcript: str
    openai_key: Optional[str] = None

class VideoClipRequest(BaseModel):
    video_url: str
    start_time: float
    end_time: float
    openai_key: Optional[str] = None

@app.get("/")
def read_root():
    return {"status": "PodShot API is running"}

@app.post("/process-clip")
async def process_clip(clip_request: VideoClipRequest, background_tasks: BackgroundTasks):
    """Process a video clip to extract transcript and insights - keeps compatibility with old extension"""
    task_id = str(uuid.uuid4())
    processing_status[task_id] = {
        "status": "processing",
        "message": "Starting clip processing"
    }
    
    background_tasks.add_task(
        process_clip_task, 
        task_id, 
        clip_request.video_url, 
        clip_request.start_time, 
        clip_request.end_time
    )
    
    return {"task_id": task_id, "status": "processing"}

@app.get("/status/{task_id}")
async def check_status(task_id: str):
    """Check the status of a processing task"""
    if task_id not in processing_status:
        return JSONResponse(status_code=404, content={"detail": "Task not found"})
    
    return processing_status[task_id]

@app.post("/generate-insights")
async def generate_insights_old(request: InsightsRequest):
    """Generate insights using old API format"""
    try:
        # Use environment OpenAI key if not provided in request
        openai_key = request.openai_key or os.getenv("OPENAI_API_KEY")
        
        if not openai_key:
            return JSONResponse(status_code=400, content={"detail": "OpenAI API key is required"})
            
        # Create a temporary client with the provided key if different
        temp_client = client
        if request.openai_key:
            temp_client = openai.OpenAI(api_key=request.openai_key)
            
        print(f"Generating insights for transcript (length: {len(request.transcript)})")
        
        response = temp_client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": "You are taking quick personal notes while watching a video. Your notes must follow these strict rules:\n1. Always use ONLY numbered format (1., 2., 3.) - never bullet points\n2. Write in first-person, conversational style\n3. Keep each point short and focused on one key idea\n4. NEVER mention transcripts, speakers, videos, or content - write as if these are your own thoughts\n5. Avoid any analytical language or academic tone\n6. Focus on practical takeaways someone would actually write down"},
                {"role": "user", "content": f"Write exactly 3 numbered personal notes (1., 2., 3.) I would jot down while watching. Be concise and direct:\n{request.transcript}"}
            ],
            max_tokens=200
        )
        
        insights = response.choices[0].message.content
        print(f"Generated insights: {insights[:100]}...")
        return {"insights": insights}
        
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Error generating insights: {str(e)}"})

@app.post("/insights")
async def generate_insights(req: InsightsRequest):
    """New endpoint for insights generation"""
    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are an assistant that summarizes video transcripts into concise insights. Provide insights directly without prefixing with 'Key Insights:' or similar headers."},
                {"role": "user", "content": req.transcript}
            ],
            max_tokens=200
        )
        insights = response.choices[0].message.content
        return {"insights": insights}
    except Exception as e:
        return {"error": str(e)}

@app.post("/transcribe")
async def transcribe_clip(req: TranscribeRequest):
    try:
        # 1. Download video
        with tempfile.TemporaryDirectory() as tmpdir:
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': os.path.join(tmpdir, 'audio.%(ext)s'),
                'quiet': True
            }
            audio_path = None
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(req.video_url, download=True)
                audio_path = ydl.prepare_filename(info)
                if not audio_path.endswith('.mp3'):
                    # Convert to mp3 for whisper
                    mp3_path = os.path.join(tmpdir, 'audio.mp3')
                    ffmpeg.input(audio_path).output(mp3_path).run(overwrite_output=True, quiet=True)
                    audio_path = mp3_path

            # 2. Extract audio segment
            segment_path = os.path.join(tmpdir, 'segment.mp3')
            ffmpeg.input(audio_path, ss=req.start_time, to=req.end_time).output(segment_path).run(overwrite_output=True, quiet=True)

            # 3. Transcribe audio (using whisper as example)
            import whisper
            model = whisper.load_model("base")
            result = model.transcribe(segment_path)
            transcript = result.get("text", "")
            return {"transcript": transcript}
    except Exception as e:
        import traceback
        print("Transcription error:", str(e))
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"transcript": "", "error": str(e)})

@app.post("/transcribe_full")
async def transcribe_full_video(req: TranscribeFullRequest):
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': os.path.join(tmpdir, 'audio.%(ext)s'),
                'quiet': True
            }
            audio_path = None
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(req.video_url, download=True)
                audio_path = ydl.prepare_filename(info)
                if not audio_path.endswith('.mp3'):
                    mp3_path = os.path.join(tmpdir, 'audio.mp3')
                    ffmpeg.input(audio_path).output(mp3_path).run(overwrite_output=True, quiet=True)
                    audio_path = mp3_path

            # Transcribe full audio
            import whisper
            model = whisper.load_model("base")
            result = model.transcribe(audio_path)
            transcript = result.get("text", "")
            return {"transcript": transcript}
    except Exception as e:
        import traceback
        print("Full transcription error:", str(e))
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"transcript": "", "error": str(e)})

async def process_clip_task(task_id, video_url, start_time, end_time):
    """Background task to process video clip"""
    try:
        processing_status[task_id]["message"] = "Downloading video clip"
        
        # Use the existing transcribe function implementation by creating a request
        req = TranscribeRequest(
            video_url=video_url,
            start_time=start_time,
            end_time=end_time
        )
        
        # Call the transcribe function directly for background processing
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                ydl_opts = {
                    'format': 'bestaudio/best',
                    'outtmpl': os.path.join(tmpdir, 'audio.%(ext)s'),
                    'quiet': True
                }
                audio_path = None
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(video_url, download=True)
                    audio_path = ydl.prepare_filename(info)
                    if not audio_path.endswith('.mp3'):
                        # Convert to mp3 for whisper
                        mp3_path = os.path.join(tmpdir, 'audio.mp3')
                        ffmpeg.input(audio_path).output(mp3_path).run(overwrite_output=True, quiet=True)
                        audio_path = mp3_path

                # Extract audio segment
                segment_path = os.path.join(tmpdir, 'segment.mp3')
                ffmpeg.input(audio_path, ss=start_time, to=end_time).output(segment_path).run(overwrite_output=True, quiet=True)

                # Transcribe audio
                processing_status[task_id]["message"] = "Generating transcript"
                import whisper
                model = whisper.load_model("base")
                result = model.transcribe(segment_path)
                transcript = result.get("text", "")

                # Generate insights
                processing_status[task_id]["message"] = "Generating insights"
                response = client.chat.completions.create(
                    model="gpt-4o",
                    messages=[
                        {"role": "system", "content": "You are taking quick personal notes while watching a video. Your notes must follow these strict rules:\n1. Always use ONLY numbered format (1., 2., 3.) - never bullet points\n2. Write in first-person, conversational style\n3. Keep each point short and focused on one key idea\n4. NEVER mention transcripts, speakers, videos, or content - write as if these are your own thoughts\n5. Avoid any analytical language or academic tone\n6. Focus on practical takeaways someone would actually write down"},
                        {"role": "user", "content": f"Write exactly 3 numbered personal notes (1., 2., 3.) I would jot down while watching. Be concise and direct:\n{transcript}"}
                    ],
                    max_tokens=200
                )
                
                insights = response.choices[0].message.content
                
                # Update status with completed information
                processing_status[task_id] = {
                    "status": "completed",
                    "transcript": transcript,
                    "insights": insights
                }
                
        except Exception as e:
            processing_status[task_id] = {
                "status": "error",
                "message": f"Error processing clip: {str(e)}"
            }
            
    except Exception as e:
        processing_status[task_id] = {
            "status": "error",
            "message": f"Unexpected error: {str(e)}"
        }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)