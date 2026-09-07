import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleFlight } from "./single-flight.js";

test("同じ鍵で同時に呼んでも、中身は1度しか走らない", async () => {
  const flight = new SingleFlight<string>();
  let started = 0;
  const slow = async () => {
    started += 1;
    await new Promise((r) => setTimeout(r, 20));
    return "ok";
  };

  const results = await Promise.all([
    flight.run("vault", slow),
    flight.run("vault", slow),
    flight.run("vault", slow),
  ]);

  assert.equal(started, 1, "**二重に起動している**");
  assert.deepEqual(results, ["ok", "ok", "ok"]);
});

test("違う鍵は互いに待たない", async () => {
  const flight = new SingleFlight<string>();
  let started = 0;
  const slow = async () => {
    started += 1;
    await new Promise((r) => setTimeout(r, 10));
    return "ok";
  };
  await Promise.all([flight.run("a", slow), flight.run("b", slow)]);
  assert.equal(started, 2);
});

test("終わったら次の呼び出しは新しく走る（走行中だけ束ねる）", async () => {
  const flight = new SingleFlight<number>();
  let n = 0;
  const inc = async () => ++n;
  assert.equal(await flight.run("k", inc), 1);
  assert.equal(await flight.run("k", inc), 2);
});

test("失敗しても次に持ち越さない——失敗した1本に永久にぶら下がらない", async () => {
  const flight = new SingleFlight<string>();
  await assert.rejects(flight.run("k", async () => {
    throw new Error("起動に失敗");
  }));
  assert.equal(await flight.run("k", async () => "ok"), "ok");
});
