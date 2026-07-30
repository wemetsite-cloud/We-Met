FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY customer-site/ /app/customer-site/
COPY employee-site/ /app/employee-site/
COPY admin-site/ /app/admin-site/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start:production"]
