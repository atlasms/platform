# ADR-0010 checks 1 and 2: the same worker in each candidate base image, its workflow code bundled
# at BUILD time. BASE is the image under test; APK adds packages to an Alpine one (e.g. gcompat).
ARG BASE=node:24-alpine
FROM ${BASE}
ARG APK=""
RUN if [ -n "$APK" ]; then apk add --no-cache $APK; fi
WORKDIR /spike
COPY worker/package.json worker/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY worker/ ./
# Check 2: bundling happens here, once, in the image build.
RUN node bundle.mjs
ENV TASK_QUEUE=spike
CMD ["node", "src/worker.ts"]
