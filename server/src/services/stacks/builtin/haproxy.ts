import * as fs from "fs";
import * as path from "path";
import { StackDefinition } from "@mini-infra/types";
import { portUtils } from "../../port-utils";
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

  const portConfig = await portUtils.getHAProxyPortsForEnvironment(
    context.environmentId
  );

  return {
    name: "haproxy",
    description: "HAProxy load balancer with DataPlane API",
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
              hostPort: portConfig.httpPort,
              protocol: "tcp",
            },
            {
              containerPort: 443,
              hostPort: portConfig.httpsPort,
              protocol: "tcp",
            },
            {
              containerPort: 8404,
              hostPort: portConfig.statsPort,
              protocol: "tcp",
            },
            {
              containerPort: 5555,
              hostPort: portConfig.dataplanePort,
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
  builtinVersion: 2,
  scope: 'environment',
  resolve: (context) => buildHAProxyDefinition(context),
};
