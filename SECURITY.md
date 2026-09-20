# Security

This is an experimental local application. Only the latest source revision receives fixes. The server binds to loopback; it is not designed to be exposed directly to the internet.

Please use GitHub's private vulnerability reporting feature if it is enabled on this repository. Do not post credentials, tokens, full OAuth callback URLs, or exploitable security details in public issues. If private reporting is unavailable, open an issue requesting a private contact channel without disclosing the vulnerability.

Credentials are stored on the local filesystem with restricted permissions. Conversations are stored in browser local storage. Logout removes this connector's session; it does not revoke provider tokens or sign out other applications. Avoid sharing your local machine account or exposing the local server through a tunnel.

Web conversations run an agent with file and shell tools in the server's working
directory. Start the server from a workspace you intend the agent to access.
Harness session logs persist under `~/.config/frontier-connector/harness`;
browser activity traces can also contain file contents and tool output.
The SDK transport cannot display interactive approval prompts, so operations
requiring those prompts fail closed under the default workspace policy.
