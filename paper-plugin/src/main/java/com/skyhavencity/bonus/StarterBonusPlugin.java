package com.skyhavencity.bonus;

import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class StarterBonusPlugin extends JavaPlugin {

    private static final int BONUS_AMOUNT = 50000;
    private static final Pattern CLAIM_ID_PATTERN = Pattern.compile("\"claimId\"\\s*:\\s*\"([0-9a-fA-F-]{36})\"");
    private static final Pattern PLAYER_NAME_PATTERN = Pattern.compile("\"playerName\"\\s*:\\s*\"((?:[A-Za-z0-9_]{3,16}|\\.[A-Za-z0-9_]{2,15}))\"");
    private static final Pattern AMOUNT_PATTERN = Pattern.compile("\"amount\"\\s*:\\s*(\\d+)");

    private final Set<UUID> claimed = new HashSet<>();
    private final AtomicBoolean pollInProgress = new AtomicBoolean();
    private String workerUrl;
    private String workerSecret;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        loadSettings();

        if (workerSecret.isBlank() || workerSecret.equals("CHANGE_ME")) {
            getLogger().severe("Set worker-secret in plugins/StarterBonus/config.yml before enabling this plugin.");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        getLogger().info("Starter bonus plugin enabled.");
        Bukkit.getScheduler().runTaskTimer(this, this::pollQueue, 20L, 100L);
    }

    private void pollQueue() {
        if (!pollInProgress.compareAndSet(false, true)) {
            return;
        }

        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            try {
                Claim claim = fetchNextClaim();
                if (claim == null) {
                    pollInProgress.set(false);
                    return;
                }
                Bukkit.getScheduler().runTask(this, () -> processClaim(claim));
            } catch (Exception e) {
                getLogger().warning("Could not poll bonus queue: " + e.getMessage());
                pollInProgress.set(false);
            }
        });
    }

    private Claim fetchNextClaim() throws Exception {
        HttpURLConnection connection = openConnection(workerUrl, "GET");
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) {
            getLogger().warning("Worker returned HTTP " + status + " while polling claims.");
            connection.disconnect();
            return null;
        }

        String body = readResponse(connection);
        connection.disconnect();
        if (!body.contains("\"queued\":true")) {
            return null;
        }

        String claimId = match(CLAIM_ID_PATTERN, body);
        String playerName = match(PLAYER_NAME_PATTERN, body);
        String amountText = match(AMOUNT_PATTERN, body);
        if (claimId == null || playerName == null || amountText == null) {
            getLogger().warning("Worker returned a malformed claim; it was left in the queue.");
            return null;
        }

        int amount = Integer.parseInt(amountText);
        if (amount != BONUS_AMOUNT) {
            getLogger().warning("Worker returned an unexpected bonus amount; claim was not processed.");
            return null;
        }
        return new Claim(claimId, playerName, amount);
    }

    private void processClaim(Claim claim) {
        Player player = Bukkit.getOnlinePlayers().stream()
                .filter(candidate -> candidate.getName().equalsIgnoreCase(claim.playerName()))
                .findFirst()
                .orElse(null);

        if (player == null) {
            deferClaim(claim.id(), 60);
            return;
        }

        UUID playerId = player.getUniqueId();
        if (claimed.contains(playerId)) {
            acknowledgeClaim(claim.id());
            return;
        }

        boolean commandAccepted = Bukkit.dispatchCommand(
                Bukkit.getConsoleSender(),
                "eco give " + player.getName() + " " + BONUS_AMOUNT
        );
        if (!commandAccepted) {
            getLogger().warning("The eco command was unavailable or rejected the bonus for " + player.getName() + ".");
            deferClaim(claim.id(), 60);
            return;
        }

        claimed.add(playerId);
        getConfig().set("claimed-uuids", claimed.stream().map(UUID::toString).toList());
        saveConfig();
        getLogger().info("Granted the starter bonus to " + player.getName() + " (UUID: " + playerId + ").");
        acknowledgeClaim(claim.id());
    }

    private void acknowledgeClaim(String claimId) {
        sendQueueAction("/ack", claimId, null);
    }

    private void deferClaim(String claimId, int retryAfterSeconds) {
        sendQueueAction("/defer", claimId, retryAfterSeconds);
    }

    private void sendQueueAction(String path, String claimId, Integer retryAfterSeconds) {
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            try {
                String payload = "{\"claimId\":\"" + claimId + "\"";
                if (retryAfterSeconds != null) {
                    payload += ",\"retryAfterSeconds\":" + retryAfterSeconds;
                }
                payload += "}";

                HttpURLConnection connection = openConnection(endpoint(path), "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload.getBytes(StandardCharsets.UTF_8));
                }

                int status = connection.getResponseCode();
                String response = readResponse(connection);
                connection.disconnect();
                if (status < 200 || status >= 300 || !response.contains("\"updated\":true")) {
                    getLogger().warning("Worker did not confirm queue action " + path + " (HTTP " + status + ").");
                }
            } catch (Exception e) {
                getLogger().warning("Could not send queue action " + path + ": " + e.getMessage());
            } finally {
                pollInProgress.set(false);
            }
        });
    }

    private HttpURLConnection openConnection(String address, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create(address).toURL().openConnection();
        connection.setRequestMethod(method);
        connection.setRequestProperty("Authorization", "Bearer " + workerSecret);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        return connection;
    }

    private String endpoint(String path) {
        return workerUrl.substring(0, workerUrl.lastIndexOf("/claim")) + path;
    }

    private String readResponse(HttpURLConnection connection) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder response = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                response.append(line);
            }
            return response.toString();
        }
    }

    private String match(Pattern pattern, String source) {
        Matcher matcher = pattern.matcher(source);
        return matcher.find() ? matcher.group(1) : null;
    }

    private void loadSettings() {
        reloadConfig();
        workerUrl = getConfig().getString("worker-url", "https://bonus-skyhaven-worker.masterbsproreal.workers.dev/claim").trim();
        workerSecret = getConfig().getString("worker-secret", "CHANGE_ME").trim();
        claimed.clear();
        List<String> savedClaims = new ArrayList<>(getConfig().getStringList("claimed-uuids"));
        for (String savedClaim : savedClaims) {
            try {
                claimed.add(UUID.fromString(savedClaim));
            } catch (IllegalArgumentException e) {
                getLogger().warning("Ignoring invalid UUID in claimed-uuids: " + savedClaim);
            }
        }
    }

    private record Claim(String id, String playerName, int amount) {}

    @Override
    public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (cmd.getName().equalsIgnoreCase("starterbonus") && sender.hasPermission("starterbonus.reload")) {
            loadSettings();
            sender.sendMessage("Starter bonus config reloaded.");
            return true;
        }
        return false;
    }
}
