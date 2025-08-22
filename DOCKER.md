# Guide: Running WiseJSON DB with Docker

Using Docker is the recommended way to run the WiseJSON server component, which provides the Data Explorer UI and the synchronization API for your client-side databases.

This guide covers everything from a quick start to advanced configuration.

### Prerequisites

- [Docker](https://www.docker.com/get-started) installed on your system.
- [Docker Compose](https://docs.docker.com/compose/install/) (usually included with Docker Desktop).

---

## 1. Quickest Start (Using the Official Image)

This method is perfect for quickly trying out the Data Explorer or setting up a sync server without cloning the repository.

#### Step 1: Run the Container

Execute the following command in your terminal:

```bash
docker run -d -p 3000:3000 \
  -v wisejson_data:/data \
  -e WISEJSON_EXPLORER_ALLOW_WRITE=true \
  --name wisejson-server \
  your_dockerhub_username/wisejson-server:latest
```
*(Replace `your_dockerhub_username` with the actual Docker Hub repository name)*

Let's break down this command:
- `-d`: Runs the container in detached mode (in the background).
- `-p 3000:3000`: Maps port 3000 on your local machine to port 3000 inside the container.
- `-v wisejson_data:/data`: **(Crucial for Data Persistence)** Mounts a named Docker volume `wisejson_data` to the `/data` directory inside the container. This is where your database files will be stored, ensuring they persist even if the container is removed.
- `-e WISEJSON_EXPLORER_ALLOW_WRITE=true`: An example of setting an environment variable to enable write operations in the Data Explorer.
- `--name wisejson-server`: Gives your container a memorable name.
- `your_dockerhub_username/wisejson-server:latest`: The name of the official image on Docker Hub.

Your server is now running! Access the Data Explorer at **[http://localhost:3000](http://localhost:3000)**.

#### Step 2: Managing the Container
- **View logs:** `docker logs wisejson-server`
- **Stop the container:** `docker stop wisejson-server`
- **Start the container again:** `docker start wisejson-server`
- **Remove the container:** `docker rm wisejson-server` (your data in the `wisejson_data` volume will be safe).

---

## 2. Local Development with `docker-compose`

Using `docker-compose` is ideal for local development and for integrating the WiseJSON server into your own multi-container application. A `docker-compose.yml` file is included in this repository.

#### Step 1: Start the Server

From the root of the WiseJSON DB repository, run:
```bash
docker-compose up -d
```
This command reads the `docker-compose.yml` file, builds the image if it doesn't exist locally (or pulls it if `image:` is specified), and starts the container with all the pre-defined configuration.

#### Step 2: Stop the Server
```bash
docker-compose down
```
This stops and removes the container and its network. To also remove the data volume, use `docker-compose down -v`.

---

## 3. Data Persistence Explained

WiseJSON DB stores its data on the filesystem. When running in Docker, it's critical **not** to store this data inside the container's ephemeral filesystem. We use **Docker Volumes** for this.

A volume is a Docker-managed storage area on your host machine that is mounted into a container.

- **To list your volumes:** `docker volume ls`
- **To inspect a volume (and see where it's stored on your machine):** `docker volume inspect wisejson_data`

By using a volume, you can freely stop, remove, and update the `wisejson-server` container without ever losing your database data.

---

## 4. Configuration via Environment Variables

You can configure the server container by passing environment variables using the `-e` flag with `docker run` or the `environment` section in `docker-compose.yml`.

| Variable                        | Description                                                              | Default                  |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------ |
| `PORT`                          | The port the server will listen on *inside* the container.               | `3000`                   |
| `WISE_JSON_PATH`                | The path for database storage *inside* the container. Must match the volume mount point. | `/data`                  |
| `LOG_LEVEL`                     | The logging level (`error`, `warn`, `info`, `debug`, or `none`).         | `info`                   |
| `WISEJSON_EXPLORER_ALLOW_WRITE` | Set to `true` to enable write operations (delete, index) in Data Explorer. | `false`                  |
| `WISEJSON_AUTH_USER`            | A username for basic authentication to protect the Data Explorer.        | (none)                   |
| `WISEJSON_AUTH_PASS`            | A password for basic authentication.                                     | (none)                   |

**Example with Authentication:**
```bash
docker run -d -p 3000:3000 \
  -v wisejson_data:/data \
  --name wisejson-server \
  -e WISEJSON_AUTH_USER=admin \
  -e WISEJSON_AUTH_PASS=my_secret_password \
  your_dockerhub_username/wisejson-server:latest
```

---

## 5. Building Your Own Image (Advanced)

If you need to customize the server, you can build your own Docker image from the `Dockerfile` provided in the repository. This is useful if you want to modify the server code or base your image on a different version of Node.js.

**1. Clone the repository:**
```bash
git clone https://github.com/Xzdes/WiseJSON.git
cd WiseJSON
```

**2. Build the image:**
```bash
docker build -t my-custom-wisejson-server .
```

**3. Run your custom image:**
You can now run your custom image just like the official one:
```bash
docker run -d -p 3000:3000 \
  -v wisejson_data:/data \
  --name my-wisejson-server \
  my-custom-wisejson-server
