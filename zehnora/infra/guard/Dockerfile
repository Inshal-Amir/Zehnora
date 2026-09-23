# Hardware guard for the GPU PC: nvidia-smi comes from the NVIDIA runtime (glibc base needed), docker CLI to stop/start
# the model container. Same base family as the GPU check that works on the PC (docker run --gpus all ubuntu nvidia-smi).
FROM ubuntu:24.04
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
ENTRYPOINT ["bash"]
