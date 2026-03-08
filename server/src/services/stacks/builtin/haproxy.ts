import * as fs from "fs";
import * as path from "path";
import { StackDefinition } from "@mini-infra/types";
import { BuiltinStackDefinition, BuiltinStackContext } from "./types";

async function buildHAProxyDefinition(
  context: BuiltinStackContext
): Promise<StackDefinition> {
  const haproxyConfigDir = path.resolve(
    __dirname,
    "../../../../docker-compose/haproxy"
  );
  const haproxyCfg = fs.readFileSync(
    path.join(haproxyConfigDir, "haproxy.cfg"),
    "utf-8"
  );
  const dataplaneapiYml = fs.readFileSync(
    path.join(haproxyConfigDir, "dataplaneapi.yml"),
    "utf-8"
  );
  const domainBackendMap = fs.readFileSync(
    path.join(haproxyConfigDir, "domain-backend.map"),
    "utf-8"
  );

  if (!context.environmentId) {
    throw new Error("HAProxy stack requires an environmentId");
  }

  return {
    name: "haproxy",
    description: "HAProxy load balancer with DataPlane API",
    parameters: [
      { name: "http-port", type: "number", default: 80, description: "Host port for HTTP traffic" },
      { name: "https-port", type: "number", default: 443, description: "Host port for HTTPS traffic" },
      { name: "stats-port", type: "number", default: 8404, description: "Host port for HAProxy stats" },
      { name: "dataplane-port", type: "number", default: 5555, description: "Host port for DataPlane API" },
    ],
    networks: [{ name: "network", driver: "bridge" }],
    volumes: [
      { name: "haproxy_data" },
      { name: "haproxy_run" },
      { name: "haproxy_config" },
      { name: "haproxy_certs" },
    ],
    services: [
      {
        serviceName: "haproxy",
        serviceType: "Stateful",
        dockerImage: "haproxytech/haproxy-alpine",
        dockerTag: "3.2",
        containerConfig: {
          env: {
            HAPROXY_DATACENTER: "docker",
            HAPROXY_MWORKER: "1",
            DATAPLANEAPI_USERLIST_FILE:
              "/usr/local/etc/haproxy/haproxy.cfg",
          },
          ports: [
            {
              containerPort: 80,
              hostPort: "{{params.http-port}}" as any,
              protocol: "tcp",
            },
            {
              containerPort: 443,
              hostPort: "{{params.https-port}}" as any,
              protocol: "tcp",
            },
            {
              containerPort: 8404,
              hostPort: "{{params.stats-port}}" as any,
              protocol: "tcp",
            },
            {
              containerPort: 5555,
              hostPort: "{{params.dataplane-port}}" as any,
              protocol: "tcp",
            },
          ],
          mounts: [
            {
              source: "haproxy_config",
              target: "/usr/local/etc/haproxy/",
              type: "volume",
            },
            {
              source: "haproxy_certs",
              target: "/etc/ssl/certs",
              type: "volume",
            },
          ],
          restartPolicy: "unless-stopped",
          healthcheck: {
            test: [
              "CMD",
              "wget",
              "--no-verbose",
              "--tries=1",
              "--spider",
              "http://admin:admin@127.0.0.1:8404/stats",
            ],
            interval: 30,
            timeout: 5,
            retries: 3,
            startPeriod: 10,
          },
          logConfig: { type: "json-file", maxSize: "10m", maxFile: "3" },
        },
        configFiles: [
          {
            volumeName: "haproxy_config",
            path: "/haproxy.cfg",
            content: haproxyCfg,
            permissions: "666",
          },
          {
            volumeName: "haproxy_config",
            path: "/dataplaneapi.yml",
            content: dataplaneapiYml,
            permissions: "666",
          },
          {
            volumeName: "haproxy_config",
            path: "/domain-backend.map",
            content: domainBackendMap,
            permissions: "666",
          },
        ],
        initCommands: [],
        dependsOn: [],
        order: 1,
      },
    ],
  };
}

export const haproxyStack: BuiltinStackDefinition = {
  name: "haproxy",
  displayName: "HAProxy Load Balancer",
  builtinVersion: 3,
  scope: 'environment',
  category: 'infrastructure',
  resolve: (context) => buildHAProxyDefinition(context),
};
