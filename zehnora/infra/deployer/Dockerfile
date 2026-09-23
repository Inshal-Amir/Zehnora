# Auto-deploy loop for the GPU PC: docker CLI + compose (from the base image), git, bash, su-exec.
FROM docker:29-cli
RUN apk add --no-cache bash git su-exec
ENTRYPOINT ["bash"]
