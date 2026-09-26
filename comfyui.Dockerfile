# ComfyUI runtime environment — Python + pip dependencies ONLY.
#
# LICENSING (docs/adr/0001): ComfyUI is GPL-3.0 and must never be
# redistributed inside a Safelight image. This Dockerfile therefore copies
# NOTHING from the ComfyUI tree except requirements.txt (a dependency list);
# the ComfyUI code itself is bind-mounted from the user's local ./comfyui
# clone at container start (see docker-compose.yml). The resulting image
# contains only third-party pip packages. Even so: NEVER push or publish
# this image anywhere — it is built locally, from the user's own clone,
# at run time.
#
# Built by compose with context ./comfyui so requirements.txt is available:
#   build: { context: ./comfyui, dockerfile: ../comfyui.Dockerfile }
#
# CPU by default (works everywhere, slow). For a Linux host with an NVIDIA
# GPU, see the commented GPU variant below and the gpu notes in
# docker-compose.yml. macOS Docker has NO GPU passthrough — on a Mac, keep
# running ComfyUI natively via scripts/comfy.sh (Metal/MPS) instead.

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- CPU torch (default) ---------------------------------------------------
# Install torch from the CPU wheel index first so requirements.txt does not
# pull the multi-GB CUDA build.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir torch torchvision torchaudio \
      --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r /tmp/requirements.txt

# --- GPU torch (NVIDIA, Linux only) ----------------------------------------
# Replace the CPU block above with the default (CUDA) wheels:
#   RUN pip install --no-cache-dir torch torchvision torchaudio \
#    && pip install --no-cache-dir -r /tmp/requirements.txt
# and uncomment the `deploy.resources` GPU reservation on the comfyui
# service in docker-compose.yml (requires the NVIDIA Container Toolkit).

# The ComfyUI clone is mounted here at run time (read-write: ComfyUI writes
# temp/user files into its own tree). Models, inputs and outputs are their
# own mounts — see docker-compose.yml.
VOLUME /app

EXPOSE 8188

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8188/system_stats', timeout=4).status==200 else 1)"

# --cpu forces CPU inference; drop it in the GPU variant.
CMD ["python", "main.py", \
     "--listen", "0.0.0.0", \
     "--port", "8188", \
     "--cpu", \
     "--preview-method", "auto", \
     "--output-directory", "/outputs", \
     "--input-directory", "/inputs"]
