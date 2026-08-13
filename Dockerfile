# syntax = docker/dockerfile:1

ARG NODE_VERSION=26.7.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app

# Throw-away build stage to reduce size of final image
FROM base AS build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

COPY package-lock.json package.json ./
RUN npm ci

COPY . .

# Final stage for app image
FROM base

ENV NODE_ENV="production"

COPY --from=build /app /app

EXPOSE 3000
CMD [ "npm", "run", "start" ]