# CI Photo Time Machine — web viewer (build + static serve).
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
# API base is baked in at build time (CRA). Override with --build-arg REACT_APP_API_BASE=...
ARG REACT_APP_API_BASE=http://localhost:8000
ENV REACT_APP_API_BASE=$REACT_APP_API_BASE
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
