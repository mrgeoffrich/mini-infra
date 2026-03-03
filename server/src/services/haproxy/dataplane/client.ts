import { HAProxyDataPlaneClientBase } from './base';
import { BackendMixin } from './mixin-backend';
import { StatsMixin } from './mixin-stats';
import { ServerMixin } from './mixin-server';
import { FrontendMixin } from './mixin-frontend';
import { ACLMixin } from './mixin-acl';
import { SwitchingRulesMixin } from './mixin-switching-rules';
import { SSLMixin } from './mixin-ssl';

// Compose all mixins into the final client class
const ComposedClient = SSLMixin(
  SwitchingRulesMixin(
    ACLMixin(
      FrontendMixin(
        ServerMixin(
          StatsMixin(
            BackendMixin(HAProxyDataPlaneClientBase)
          )
        )
      )
    )
  )
);

export class HAProxyDataPlaneClient extends ComposedClient {}

export default HAProxyDataPlaneClient;
