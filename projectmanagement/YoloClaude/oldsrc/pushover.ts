export interface PushoverConfig {
  token: string;
  user: string;
}

export interface PushoverMessage {
  message: string;
  device?: string;
  title?: string;
  priority?: -2 | -1 | 0 | 1 | 2;
  sound?: string;
  url?: string;
  html?: boolean;
  timestamp?: number;
  ttl?: number;
}

export interface PushoverResponse {
  status: number;
  request: string;
  errors?: string[];
}

export class PushoverClient {
  private readonly apiUrl = 'https://api.pushover.net/1/messages.json';
  private readonly config: PushoverConfig;
  
  constructor(config?: PushoverConfig) {
    if (!config) {
      const token = process.env.PUSHOVER_APP_TOKEN;
      const user = process.env.PUSHOVER_USER_KEY;
      
      if (!token || !user) {
        throw new Error('PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY environment variables must be set or config must be provided');
      }
      
      this.config = { token, user };
    } else {
      this.config = config;
    }
  }

  async sendMessage(message: PushoverMessage): Promise<PushoverResponse> {
    const payload = {
      token: this.config.token,
      user: this.config.user,
      ...message,
    };

    const formData = new URLSearchParams();
    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined) {
        formData.append(key, String(value));
      }
    });

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
    });

    const data = await response.json() as PushoverResponse;
    
    if (!response.ok) {
      throw new Error(`Pushover API error: ${data.errors?.join(', ') || 'Unknown error'}`);
    }

    return data;
  }

  async sendSimpleMessage(message: string, title?: string): Promise<PushoverResponse> {
    const messageData: PushoverMessage = { message };
    if (title) {
      messageData.title = title;
    }
    return this.sendMessage(messageData);
  }
}