// Minimal dev-boot entry: renders a prompt input + Generate button into #app.
// Wiring to the /api contract is added by a later chunk; for now Generate only logs.
const app = document.getElementById("app");
if (!app) {
  throw new Error("#app mount point missing from index.html");
}

const input = document.createElement("input");
input.type = "text";
input.placeholder = "Describe a scene…";

const button = document.createElement("button");
button.textContent = "Generate";
button.addEventListener("click", () => {
  console.log("generate", input.value);
});

app.append(input, button);
