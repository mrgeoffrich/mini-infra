export const letsencrypt = {
  production: "https://acme-v02.api.letsencrypt.org/directory",
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
};

export const buypass = {
  production: "https://api.buypass.com/acme/directory",
};

export const zerossl = {
  production: "https://acme.zerossl.com/v2/DV90",
};

export const directory = { letsencrypt, buypass, zerossl };
