document.addEventListener("DOMContentLoaded", () => {
  const serverButtons = document.querySelectorAll(".discord-button[data-server-address]");
  serverButtons.forEach((serverButton) => {
    serverButton.addEventListener("click", async () => {
      const serverAddress = serverButton.dataset.serverAddress;

      try {
        await navigator.clipboard.writeText(serverAddress);
      } catch {
        const addressInput = document.createElement("input");
        addressInput.value = serverAddress;
        document.body.appendChild(addressInput);
        addressInput.select();
        document.execCommand("copy");
        addressInput.remove();
      }

      const originalText = serverButton.textContent;
      serverButton.textContent = "Adresse kopiert";
      window.setTimeout(() => {
        serverButton.textContent = originalText;
      }, 1600);
    });
  });

  const claimForm = document.querySelector("#claimForm");
  const claimStatus = document.querySelector("#claimStatus");
  const playerNameInput = document.querySelector("#playerName");
  const claimButton = document.querySelector("#claimBtn");

  if (claimForm && claimStatus && playerNameInput && claimButton) {
    const CLAIM_API_URL = "https://bonus-skyhaven-worker.masterbsproreal.workers.dev/claim";

    claimForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const playerName = playerNameInput.value.trim();
      const validName = /^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$/.test(playerName);

      if (!validName) {
        claimStatus.textContent = "Bitte gib einen gültigen Minecraft-Namen ein.";
        claimStatus.style.color = "#fdb4b4";
        playerNameInput.focus();
        return;
      }

      claimButton.disabled = true;
      claimButton.textContent = "Wird geprüft...";
      claimStatus.style.color = "#a7b8d6";
      claimStatus.textContent = "Bonus wird an deinen Minecraft-Account gesendet...";

      try {
        const response = await fetch(CLAIM_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerName })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.message || "Der Bonus konnte nicht verarbeitet werden.");
        }

        claimStatus.style.color = "#5ae4a8";
        claimStatus.textContent = `Bonus eingereicht für ${playerName}. Der Server prüft die Anfrage jetzt.`;
        claimForm.reset();
      } catch (error) {
        claimStatus.style.color = "#fdb4b4";
        claimStatus.textContent = error.message || "Ein Fehler ist aufgetreten.";
      } finally {
        claimButton.disabled = false;
        claimButton.textContent = "50000 Eco holen";
      }
    });
  }
});
