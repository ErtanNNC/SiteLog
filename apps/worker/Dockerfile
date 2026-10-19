# TalkOlog worker — Node 22 + ffmpeg. Build from the repo root:
#   docker build -f apps/worker/Dockerfile -t sitelog-worker .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/pdf/package.json packages/pdf/
COPY apps/worker/package.json apps/worker/
# ffmpeg-static would download a binary at install time; the image uses the Debian package instead.
RUN pnpm install --frozen-lockfile --filter @sitelog/worker... --config.ignore-scripts=true
COPY packages/shared packages/shared
COPY packages/pdf packages/pdf
COPY apps/worker apps/worker
RUN pnpm --filter @sitelog/worker build

FROM node:22-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH FFMPEG_PATH=/usr/bin/ffmpeg
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml /repo/.npmrc ./
COPY --from=build /repo/packages/shared/package.json packages/shared/
COPY --from=build /repo/packages/pdf/package.json packages/pdf/
COPY --from=build /repo/apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --prod --filter @sitelog/worker... --config.ignore-scripts=true
COPY --from=build /repo/apps/worker/dist apps/worker/dist
WORKDIR /repo/apps/worker
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
