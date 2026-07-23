# banto

## Running the daemon

### Development

```sh
BANTO_PORT=3000 BANTO_DATA_DIR=./data node --import tsx packages/banto-daemon/src/index.ts
```

### systemd (Ubuntu VM, production)

1. Copy the service file:

```sh
sudo cp deploy/banto-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
```

2. Create the data directory and service user:

```sh
sudo useradd --system --no-create-home banto
sudo mkdir -p /var/lib/banto/data
sudo chown banto:banto /var/lib/banto/data
```

3. Enable and start:

```sh
sudo systemctl enable --now banto-daemon
sudo journalctl -fu banto-daemon
```

### Configuration

| Environment variable | Default      | Description           |
|---------------------|--------------|-----------------------|
| `BANTO_PORT`        | `3000`       | HTTP/WS listen port   |
| `BANTO_DATA_DIR`    | `./data`     | Event log + registry  |

### API quick-reference

```
GET  /api/v1/health
GET  /api/v1/projects
POST /api/v1/projects                         { id, repoPath, profile? }
GET  /api/v1/projects/:proj/tasks
POST /api/v1/projects/:proj/tasks             { id, title, ... }
GET  /api/v1/projects/:proj/tasks/:id
GET  /api/v1/projects/:proj/tasks/:id/events
POST /api/v1/projects/:proj/tasks/:id/transition  { to, reason? }
GET  /api/v1/tasks/:proj/:id                  (global reference)
WS   /ws                                      subscribe { type:"subscribe", projectTag, after_event_id? }
```