function claim() {
    let name = document.getElementById("mcname").value;
    let msg = document.getElementById("msg");

    if (name === "") {
        msg.innerHTML = "❌ Bitte Minecraft Namen eingeben!";
        return;
    }

    // Fake-Check (später verbinden wir das mit Plugin!)
    msg.innerHTML = "⏳ Anfrage wird verarbeitet...";

    setTimeout(() => {
        msg.innerHTML = "✅ 2500 Gems für " + name + " angefordert!";
    }, 1500);
}