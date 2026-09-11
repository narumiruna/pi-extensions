// Follow Husky's guidance for production and CI installs:
// https://typicode.github.io/husky/how-to.html#ci-server-and-docker
if (process.env.NODE_ENV === "production" || process.env.CI === "true") {
  process.exit(0);
}

const husky = (await import("husky")).default;
console.log(husky());
