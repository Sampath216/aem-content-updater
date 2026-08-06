from fastapi import FastAPI

# Create the application
app = FastAPI(
    title="AEM Content Updater",
    description="Enterprise tool to discover and update AEM components",
    version="0.1.0"
)

# Simple health check endpoint
@app.get("/")
def home():
    return {
        "message": "AEM Content Updater API is running successfully!",
        "status": "healthy",
        "version": "0.1.0"
    }

# Another simple test endpoint
@app.get("/health")
def health_check():
    return {"status": "ok"}