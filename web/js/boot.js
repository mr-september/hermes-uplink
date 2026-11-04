// Classic-script bootstrap. The CSP runs only the scripts index.html pins by digest, plus scripts those scripts insert
// ('strict-dynamic'). A module script written into the HTML, and its imports, would count as parser-inserted and be
// blocked; inserted from here, the app's entry module and its whole import graph are trusted.
const entry = document.createElement("script");
entry.type = "module";
entry.src = "js/main.js";
entry.onerror = ()=>{
  document.getElementById("authDiag").textContent = "The application could not load. Reload the page.";
  document.getElementById("authModal").classList.remove("hidden");
};
document.head.appendChild(entry);
