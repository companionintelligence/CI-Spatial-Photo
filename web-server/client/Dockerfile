# CI Photo Time Machine — web viewer (build + static serve).
# Node 22 and `npm ci`, the same as .github/workflows/ci.yml and the deploy workflow, so the
# image is built from exactly the dependency tree the lockfile names.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
# API base is baked in at build time (CRA). Override with --build-arg REACT_APP_API_BASE=...
#
# The default is empty, which the bundle reads as "same origin": it asks the host that served
# the page for /api/v1/... and /healthz, and nginx below passes those to the processing server
# at API_UPSTREAM. That is what docker compose and a Hub install want, and it works from any
# device that can open the viewer. It is NOT how photo.ci.computer is built: that bundle ships
# with the variable UNSET so each visitor's browser asks which server to use
# (src/utils/apiTarget.ts). Never build this image with http://localhost:8000: "localhost" is
# the visitor's own device, so every browser but the one on the server machine fails.
ARG REACT_APP_API_BASE=
ENV REACT_APP_API_BASE=$REACT_APP_API_BASE
RUN npm run build

FROM nginx:1.27-alpine
# Where nginx sends /api/ and /healthz: scheme://host:port with no path. "server" is the
# processing server's service name in docker-compose.yml; a Hub install sets its own.
# API_RESOLVER is Docker's embedded DNS, present on every user-defined network.
ENV API_UPSTREAM=http://server:8000 \
    API_RESOLVER=127.0.0.11
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
