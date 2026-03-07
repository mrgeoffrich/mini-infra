import { Prisma, PrismaClient } from "@prisma/client";

const TELEGRAF_CONFIG = `[agent]
  interval = "10s"
  flush_interval = "10s"

[[inputs.docker]]
  endpoint = "unix:///var/run/docker.sock"
  gather_services = false
  source_tag = false
  timeout = "5s"
  perdevice_include = ["cpu"]
  total_include = ["cpu", "blkio", "network"]
  docker_label_include = []
  docker_label_exclude = []

[[outputs.prometheus_client]]
  listen = ":9273"
  metric_version = 2
  path = "/metrics"
`;

const PROMETHEUS_CONFIG = `global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: "telegraf"
    static_configs:
      - targets: ["{{services.telegraf.containerName}}:9273"]
`;

const LOKI_CONFIG = `auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

ingester:
  lifecycler:
    ring:
      kvstore:
        store: inmemory
      replication_factor: 1

schema_config:
  configs:
    - from: "2024-04-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 168h
  max_query_length: 721h

compactor:
  working_directory: /loki/compactor
  delete_request_store: filesystem
  retention_enabled: true
  compaction_interval: 10m
  retention_delete_delay: 2h
`;

const ALLOY_CONFIG = `// Collect stdout/stderr from ALL Docker containers

discovery.docker "local" {
  host = "unix:///var/run/docker.sock"
}

discovery.relabel "docker_labels" {
  targets = discovery.docker.local.targets

  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/(.*)"
    target_label  = "container"
  }

  rule {
    source_labels = ["__meta_docker_container_image_name"]
    target_label  = "image"
  }

  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]
    target_label  = "compose_service"
  }

  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]
    target_label  = "compose_project"
  }
}

loki.source.docker "stdout" {
  host          = "unix:///var/run/docker.sock"
  targets       = discovery.docker.local.targets
  relabel_rules = discovery.relabel.docker_labels.rules
  forward_to    = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://{{services.loki.containerName}}:3100/loki/api/v1/push"
  }
}
`;

export async function seedMonitoringStack(
  prisma: PrismaClient,
  environmentId: string
): Promise<void> {
  const existing = await prisma.stack.findFirst({
    where: { name: "monitoring", environmentId },
  });
  if (existing) return;

  await prisma.stack.create({
    data: {
      name: "monitoring",
      description:
        "Container metrics monitoring with Telegraf, Prometheus, and centralized log collection with Loki and Alloy",
      environmentId,
      version: 1,
      status: "undeployed",
      networks: [{ name: "monitoring_network", driver: "bridge" }],
      volumes: [{ name: "prometheus_data" }, { name: "loki_data" }],
      services: {
        create: [
          {
            serviceName: "telegraf",
            serviceType: "Stateful",
            dockerImage: "telegraf",
            dockerTag: "latest",
            containerConfig: {
              user: "root",
              env: {},
              entrypoint: [
                "sh",
                "-c",
                "chmod 666 /var/run/docker.sock && exec /entrypoint.sh telegraf --config /telegraf-volume/config/telegraf.conf",
              ],
              ports: [
                { containerPort: 9273, hostPort: 9273, protocol: "tcp" },
              ],
              mounts: [
                {
                  source: "prometheus_data",
                  target: "/telegraf-volume",
                  type: "volume",
                  readOnly: true,
                },
                {
                  source: "/var/run/docker.sock",
                  target: "/var/run/docker.sock",
                  type: "bind",
                },
              ],
              restartPolicy: "unless-stopped",
              healthcheck: {
                test: [
                  "CMD",
                  "wget",
                  "--quiet",
                  "--tries=1",
                  "--spider",
                  "http://localhost:9273/metrics",
                ],
                interval: 30,
                timeout: 3,
                retries: 3,
                startPeriod: 10,
              },
              logConfig: { type: "json-file", maxSize: "10m", maxFile: "3" },
            },
            configFiles: [
              {
                volumeName: "prometheus_data",
                path: "/config/telegraf.conf",
                content: TELEGRAF_CONFIG,
              },
            ],
            initCommands: [],
            dependsOn: [],
            order: 1,
            routing: Prisma.DbNull,
          },
          {
            serviceName: "prometheus",
            serviceType: "Stateful",
            dockerImage: "prom/prometheus",
            dockerTag: "v3.3.0",
            containerConfig: {
              env: {},
              command: [
                "--config.file=/prometheus/config/prometheus.yml",
                "--storage.tsdb.path=/prometheus/data",
                "--storage.tsdb.retention.time=30d",
                "--web.enable-lifecycle",
              ],
              ports: [
                { containerPort: 9090, hostPort: 9090, protocol: "tcp" },
              ],
              mounts: [
                {
                  source: "prometheus_data",
                  target: "/prometheus",
                  type: "volume",
                },
              ],
              restartPolicy: "unless-stopped",
              healthcheck: {
                test: [
                  "CMD",
                  "wget",
                  "--quiet",
                  "--tries=1",
                  "--spider",
                  "http://localhost:9090/-/healthy",
                ],
                interval: 30,
                timeout: 3,
                retries: 3,
                startPeriod: 10,
              },
              logConfig: { type: "json-file", maxSize: "10m", maxFile: "3" },
            },
            configFiles: [
              {
                volumeName: "prometheus_data",
                path: "/config/prometheus.yml",
                content: PROMETHEUS_CONFIG,
              },
            ],
            initCommands: [
              {
                volumeName: "prometheus_data",
                mountPath: "/prometheus",
                commands: [
                  "mkdir -p /prometheus/config /prometheus/data",
                  "chown -R 65534:65534 /prometheus/data",
                ],
              },
            ],
            dependsOn: ["telegraf"],
            order: 2,
            routing: Prisma.DbNull,
          },
          {
            serviceName: "loki",
            serviceType: "Stateful",
            dockerImage: "grafana/loki",
            dockerTag: "3.6.0",
            containerConfig: {
              env: {},
              command: ["-config.file=/loki/config/local-config.yaml"],
              ports: [
                { containerPort: 3100, hostPort: 3100, protocol: "tcp" },
              ],
              mounts: [
                {
                  source: "loki_data",
                  target: "/loki",
                  type: "volume",
                },
              ],
              restartPolicy: "unless-stopped",
              healthcheck: {
                test: ["NONE"],
                interval: 30,
                timeout: 3,
                retries: 3,
                startPeriod: 30,
              },
              logConfig: { type: "json-file", maxSize: "10m", maxFile: "3" },
            },
            configFiles: [
              {
                volumeName: "loki_data",
                path: "/config/local-config.yaml",
                content: LOKI_CONFIG,
              },
            ],
            initCommands: [
              {
                volumeName: "loki_data",
                mountPath: "/loki",
                commands: [
                  "mkdir -p /loki/config /loki/rules /loki/chunks /loki/compactor",
                  "chown -R 10001:10001 /loki",
                ],
              },
            ],
            dependsOn: [],
            order: 3,
            routing: Prisma.DbNull,
          },
          {
            serviceName: "alloy",
            serviceType: "Stateful",
            dockerImage: "grafana/alloy",
            dockerTag: "latest",
            containerConfig: {
              user: "root",
              env: {},
              command: [
                "run",
                "/loki/config/config.alloy",
                "--server.http.listen-addr=0.0.0.0:12345",
              ],
              ports: [
                { containerPort: 12345, hostPort: 12345, protocol: "tcp" },
              ],
              mounts: [
                {
                  source: "loki_data",
                  target: "/loki",
                  type: "volume",
                  readOnly: true,
                },
                {
                  source: "/var/run/docker.sock",
                  target: "/var/run/docker.sock",
                  type: "bind",
                },
              ],
              restartPolicy: "unless-stopped",
              healthcheck: {
                test: [
                  "CMD-SHELL",
                  'bash -c "echo > /dev/tcp/localhost/12345" 2>/dev/null',
                ],
                interval: 30,
                timeout: 3,
                retries: 3,
                startPeriod: 20,
              },
              logConfig: { type: "json-file", maxSize: "10m", maxFile: "3" },
            },
            configFiles: [
              {
                volumeName: "loki_data",
                path: "/config/config.alloy",
                content: ALLOY_CONFIG,
              },
            ],
            initCommands: [],
            dependsOn: ["loki"],
            order: 4,
            routing: Prisma.DbNull,
          },
        ],
      },
    },
  });
}
