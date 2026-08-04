# Security

FoxOS is a **privileged server administration panel**. A FoxOS session has
root-equivalent access to the host because the agent can enter host namespaces,
write to the host filesystem, and control the Docker daemon.

## Safe deployment

- Keep the default `127.0.0.1` bind address.
- Reach FoxOS through an SSH tunnel, a private VPN, or an authenticated HTTPS
  reverse proxy.
- Do not publish port `8080` directly to the public internet.
- Use a unique password of at least 10 characters.
- Keep the server, Docker Engine, and FoxOS image up to date.
- Back up files before using terminal or file-management write actions.

When an HTTPS reverse proxy is in place, set `FOXOS_SECURE_COOKIE=true`.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Contact the maintainer
privately through the contact method listed on the maintainer's GitHub profile.
