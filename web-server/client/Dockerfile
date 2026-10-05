# CI Photo Time Machine — web viewer (build + static serve).
# Node 22 and `npm ci`, the same as .github/workflows/ci.yml and the deploy workflow, so the
# image is built from exactly the dependency tree the lockfile names.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# API base is baked in at build time (CRA). Override with --build-arg REACT_APP_API_BASE=...
#
# This default is for docker compose, where the viewer and the server are on the same
# machine. It is NOT how photo.ci.computer is built: that bundle ships with the variable
# UNSET so each visitor's browser asks which server to use (src/utils/apiTarget.ts). Do not
# publish an image built with this default as a hosted viewer — it would point every
# visitor's browser at their own localhost:8000.
ARG REACT_APP_API_BASE=http://localhost:8000
ENV REACT_APP_API_BASE=$REACT_APP_API_BASE
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
