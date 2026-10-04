FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm install --workspace frontend --include-workspace-root
COPY frontend ./frontend
RUN npm run build -w frontend

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY deploy/nginx-web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
