FROM node:20-slim

# Install git and basic tools required for npm install
RUN apt-get update && \
    apt-get install -y git python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

# Install dependencies
RUN npm install

COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]
