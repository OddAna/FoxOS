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

## App Store deployments

App Store applications are separate Docker containers and have their own
security model. Installing one does not automatically place it behind FoxOS
authentication.

- Keep the default **Private** (`127.0.0.1`) exposure unless the application has
  its own authentication or is protected by a trusted reverse proxy or VPN.
- Selecting **Public** (`0.0.0.0`) can make the chosen port internet-accessible,
  depending on the host firewall and provider network rules.
- Review the linked upstream project before installing. Catalog images are built
  and maintained by their respective third-party projects.
- Apps that read the Docker socket, such as Dozzle, have elevated visibility into
  the server even when the socket is mounted read-only.
- The uninstall screen preserves named volumes by default. Enabling data removal
  permanently deletes the catalog app's FoxOS-managed volume.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Contact the maintainer
privately through the contact method listed on the maintainer's GitHub profile.
