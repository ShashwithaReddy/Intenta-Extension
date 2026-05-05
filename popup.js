console.log("Popup loaded");
document.getElementById("useTabsBtn").onclick = () => {
  chrome.tabs.query({}, (tabs) => {
    const domains = tabs.map(tab => {
      try {
        return new URL(tab.url).hostname;
      } catch {
        return null;
      }
    }).filter(Boolean);

    console.log("Extracted domains:", domains);

    chrome.runtime.sendMessage({
      type: "SET_ALLOWED_SITES",
      data: { domains }
    });
  });
};