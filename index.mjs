import { createServer } from "node:http";
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";

const CONFIG = Object.freeze({
  applicationId: "1542891507445399692",
  guildId: "1464982639470710961",
  roleId: "1465858213328064593",
  targetStatus: "/shione",
  port: Number.parseInt(process.env.PORT ?? "8080", 10),
});

const token = process.env.DISCORD_TOKEN?.trim();

if (!token) {
  console.error(
    "[startup] DISCORD_TOKEN is missing. Add it as a Replit Secret; it is never read from source code.",
  );
  process.exitCode = 1;
} else if (!Number.isInteger(CONFIG.port) || CONFIG.port <= 0) {
  console.error(`[startup] PORT must be a positive integer; received "${process.env.PORT}".`);
  process.exitCode = 1;
}

const state = {
  discordReady: false,
  guildReady: false,
  lastSyncAt: null,
  lastError: null,
};

const client =
  token && process.exitCode !== 1
    ? new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildPresences,
        ],
      })
    : null;

let managedGuild = null;
let managedRole = null;
const memberSyncs = new Map();

function logError(message, error) {
  const details = error instanceof Error ? error.message : String(error);
  state.lastError = details;
  console.error(`[error] ${message}: ${details}`);
}

function hasTargetStatus(presence) {
  return (
    presence?.activities?.some(
      (activity) =>
        activity.type === ActivityType.Custom &&
        typeof activity.state === "string" &&
        activity.state.trim().toLowerCase() === CONFIG.targetStatus,
    ) ?? false
  );
}

function getHealthPayload() {
  return {
    status: state.discordReady && state.guildReady ? "ok" : "starting",
    discordReady: state.discordReady,
    guildReady: state.guildReady,
    guildId: CONFIG.guildId,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
  };
}

function startHealthServer() {
  const server = createServer((request, response) => {
    if (
      request.url !== "/healthz" &&
      request.url !== "/api/healthz" &&
      request.url !== "/"
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const payload = JSON.stringify(getHealthPayload());
    response.writeHead(state.discordReady && state.guildReady ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(payload);
  });

  server.on("error", (error) => logError("Health endpoint failed", error));
  server.listen(CONFIG.port, "0.0.0.0", () => {
    console.info(`[startup] Health endpoint listening on port ${CONFIG.port}.`);
  });
  return server;
}

async function synchronizeMember(member) {
  if (!member || member.user.bot || member.guild.id !== CONFIG.guildId) {
    return;
  }

  const shouldHaveRole = hasTargetStatus(member.presence);
  const currentlyHasRole = member.roles.cache.has(CONFIG.roleId);

  if (shouldHaveRole === currentlyHasRole) {
    return;
  }

  if (shouldHaveRole) {
    await member.roles.add(
      CONFIG.roleId,
      "Custom status matched /Shione",
    );
    console.info(`[role] Added target role to ${member.user.tag} (${member.id}).`);
  } else {
    await member.roles.remove(
      CONFIG.roleId,
      "Custom status no longer matches /Shione",
    );
    console.info(`[role] Removed target role from ${member.user.tag} (${member.id}).`);
  }
}

function queueMemberSync(member) {
  if (!member || member.user.bot) {
    return Promise.resolve();
  }

  const previous = memberSyncs.get(member.id) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await synchronizeMember(member);
      } catch (error) {
        logError(`Could not synchronize ${member.user.tag} (${member.id})`, error);
      }
    })
    .finally(() => {
      if (memberSyncs.get(member.id) === current) {
        memberSyncs.delete(member.id);
      }
    });

  memberSyncs.set(member.id, current);
  return current;
}

async function validateGuildConfiguration(guild) {
  const role = await guild.roles.fetch(CONFIG.roleId);
  if (!role) {
    throw new Error(
      `Role ${CONFIG.roleId} was not found in guild ${CONFIG.guildId}.`,
    );
  }
  if (role.managed) {
    throw new Error(
      `Role ${CONFIG.roleId} is managed by an integration and cannot be assigned by this bot.`,
    );
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error(
      "The bot needs the Manage Roles permission in the target server.",
    );
  }
  if (role.position >= botMember.roles.highest.position) {
    throw new Error(
      `Role hierarchy is invalid: move role ${CONFIG.roleId} below the bot's highest role.`,
    );
  }

  managedRole = role;
  managedGuild = guild;
  console.info(
    `[startup] Guild ${guild.name} (${guild.id}) and role ${role.name} (${role.id}) validated.`,
  );
}

async function synchronizeGuild() {
  if (!managedGuild || !managedRole) {
    throw new Error("Guild configuration has not been validated.");
  }

  const members = await managedGuild.members.fetch();
  let humanMembers = 0;
  let matchingMembers = 0;

  for (const member of members.values()) {
    if (member.user.bot) {
      continue;
    }
    humanMembers += 1;
    if (hasTargetStatus(member.presence)) {
      matchingMembers += 1;
    }
    await queueMemberSync(member);
  }

  state.lastSyncAt = new Date().toISOString();
  console.info(
    `[startup] Synchronized ${humanMembers} human member(s); ${matchingMembers} currently match /Shione.`,
  );
}

async function handleReady(readyClient) {
  console.info(
    `[startup] Logged in as ${readyClient.user.tag}. Application ${CONFIG.applicationId}.`,
  );
  console.info(
    "[startup] Gateway intents enabled: Guilds, GuildMembers, GuildPresences.",
  );

  try {
    const guild = await readyClient.guilds.fetch(CONFIG.guildId);
    await validateGuildConfiguration(guild);
    await synchronizeGuild();
    state.guildReady = true;
    state.lastError = null;
    console.info("[startup] Discord role synchronizer is ready.");
  } catch (error) {
    logError("Startup synchronization failed", error);
  }
}

async function handlePresenceUpdate(oldPresence, newPresence) {
  if (newPresence.guild?.id !== CONFIG.guildId) {
    return;
  }

  const member =
    newPresence.member ??
    (await managedGuild?.members.fetch(newPresence.userId).catch((error) => {
      logError(`Could not fetch member ${newPresence.userId}`, error);
      return null;
    }));

  if (!member || member.user.bot) {
    return;
  }

  const hadTargetStatus = hasTargetStatus(oldPresence);
  const hasStatusNow = hasTargetStatus(newPresence);
  if (hadTargetStatus === hasStatusNow) {
    return;
  }

  console.info(
    `[presence] ${member.user.tag} ${hasStatusNow ? "matched" : "no longer matches"} /Shione.`,
  );
  await queueMemberSync(member);
}

async function start() {
  if (!client || process.exitCode === 1) {
    return;
  }

  const healthServer = startHealthServer();
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.info(`[shutdown] Received ${signal}; closing Discord and health services.`);
    healthServer.close();
    client.destroy();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  client.once(Events.ClientReady, (readyClient) => {
    void handleReady(readyClient);
  });
  client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
    void handlePresenceUpdate(oldPresence, newPresence);
  });
  client.on("error", (error) => logError("Discord client error", error));
  client.on("shardError", (error) => logError("Discord gateway error", error));

  console.info(
    `[startup] Connecting to guild ${CONFIG.guildId}; target role ${CONFIG.roleId}.`,
  );
  try {
    await client.login(token);
  } catch (error) {
    logError("Discord login failed", error);
    healthServer.close();
    process.exitCode = 1;
  }
}

await start();