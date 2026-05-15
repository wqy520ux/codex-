import { describe, expect, it } from "vitest";
import { maskPii, maskSecret } from "../../src/utils/index.js";

describe("maskSecret", () => {
  it("returns *** for an empty string", () => {
    expect(maskSecret("")).toBe("***");
  });

  it("returns *** for a 1-character string", () => {
    expect(maskSecret("x")).toBe("***");
  });

  it("returns *** for an 8-character string (boundary)", () => {
    // Length 8 is still ≤ 8 → fully opaque redaction.
    expect(maskSecret("12345678")).toBe("***");
  });

  it("returns prefix/suffix preview for a 9-character string (boundary)", () => {
    // Length 9 crosses the threshold → `s[0..4] + "..." + s[-4..]`.
    expect(maskSecret("123456789")).toBe("1234...6789");
  });

  it("returns prefix/suffix preview for a typical 20-character API key", () => {
    // `sk-abcdefghijklmno12` is 20 chars → first 4 `sk-a`, last 4 `no12`.
    expect(maskSecret("sk-abcdefghijklmno12")).toBe("sk-a...no12");
  });

  it("returns *** for null and undefined defensively", () => {
    expect(maskSecret(null)).toBe("***");
    expect(maskSecret(undefined)).toBe("***");
  });

  it("returns *** for non-string runtime values (defensive path)", () => {
    // Simulates a misuse from a JS caller — TS callers cannot reach this
    // branch, but the function should still refuse to leak anything.
    expect(maskSecret(12345 as unknown as string)).toBe("***");
    expect(maskSecret({} as unknown as string)).toBe("***");
  });
});

describe("maskPii", () => {
  it("returns empty string when given empty input", () => {
    expect(maskPii("")).toBe("");
  });

  it("masks an email address", () => {
    expect(maskPii("contact me at alice@example.com please")).toBe(
      "contact me at *** please",
    );
  });

  it("masks a 中国大陆 11-digit mobile number", () => {
    expect(maskPii("我的手机号是 13800138000 欢迎联系")).toBe(
      "我的手机号是 *** 欢迎联系",
    );
  });

  it("masks an E.164 phone number", () => {
    expect(maskPii("call +14155552671 now")).toBe("call *** now");
  });

  it("masks a 13-digit card-length number", () => {
    expect(maskPii("card 1234567890123 done")).toBe("card *** done");
  });

  it("masks a 16-digit card-length number", () => {
    expect(maskPii("VISA 4111111111111111 on file")).toBe(
      "VISA *** on file",
    );
  });

  it("masks a 19-digit card-length number", () => {
    expect(maskPii("UPay 6212345678901234567 ok")).toBe("UPay *** ok");
  });

  it("leaves a 12-digit run untouched (below card length envelope)", () => {
    // The card-length regex starts at 13 digits; 12 should stay visible
    // so we do not overmatch e.g. ambient accounting numbers.
    expect(maskPii("id 123456789012 seen")).toBe("id 123456789012 seen");
  });

  it("does not mask a 13-digit run that is embedded inside a longer digit run", () => {
    // `(?<!\d)` on the left and `(?!\d)` on the right exist *precisely*
    // so we cannot partially match inside a longer numeric sequence;
    // 20 digits fails the upper bound of the card regex, so nothing is
    // replaced.
    expect(maskPii("trace 12345678901234567890 end")).toBe(
      "trace 12345678901234567890 end",
    );
  });

  it("does not mask an 11-digit run that is not a valid CN mobile prefix", () => {
    // `12345678901` fails the `1[3-9]` check; it also fails the 13+
    // card regex. Left visible.
    expect(maskPii("num 12345678901 here")).toBe("num 12345678901 here");
  });

  it("masks multiple matches of the same kind in one pass", () => {
    expect(
      maskPii("alice@x.com, bob@y.com, carol@z.com"),
    ).toBe("***, ***, ***");
  });

  it("masks mixed content — email, CN mobile, E.164, and card", () => {
    const input =
      "Email alice@corp.com mobile 13912345678 intl +8613912345678 card 4111111111111111 end";
    expect(maskPii(input)).toBe(
      "Email *** mobile *** intl *** card *** end",
    );
  });

  it("prefers the E.164 match over the embedded CN mobile inside it", () => {
    // `+8613800138000` is 14 digits total; the CN-mobile window
    // `13800138000` sits inside but is bounded on both sides by digits,
    // so CN mobile does not match. E.164 consumes the whole run.
    expect(maskPii("intl +8613800138000 call")).toBe("intl *** call");
  });

  it("does not double-mask overlapping runs (16-digit run that starts with `13`)", () => {
    // The leading 11 chars `13800138000` look like a CN mobile but the
    // trailing digit boundary fails; the full 16-digit run is consumed
    // by the card-length regex once.
    expect(maskPii("x 1380013800012345 y")).toBe("x *** y");
  });

  it("leaves whitespace- or letter-embedded digits intact so prose is untouched", () => {
    // Short numeric runs in prose (years, counts) must survive.
    expect(maskPii("year 2024 with 42 clients")).toBe(
      "year 2024 with 42 clients",
    );
  });
});
