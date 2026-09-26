// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRecentlyViewed } from "../useRecentlyViewed";

describe("useRecentlyViewed", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts empty when nothing is stored", () => {
    const { result } = renderHook(() => useRecentlyViewed());
    expect(result.current.recentlyViewed).toEqual([]);
  });

  it("adds a viewed schedule to the front of the list", () => {
    const { result } = renderHook(() => useRecentlyViewed());
    act(() => result.current.addRecentlyViewed(1));
    act(() => result.current.addRecentlyViewed(2));
    expect(result.current.recentlyViewed).toEqual([2, 1]);
  });

  it("moves a re-viewed schedule back to the front without duplicating it", () => {
    const { result } = renderHook(() => useRecentlyViewed());
    act(() => result.current.addRecentlyViewed(1));
    act(() => result.current.addRecentlyViewed(2));
    act(() => result.current.addRecentlyViewed(1));
    expect(result.current.recentlyViewed).toEqual([1, 2]);
  });

  it("caps the list at 5 entries, dropping the oldest", () => {
    const { result } = renderHook(() => useRecentlyViewed());
    for (const id of [1, 2, 3, 4, 5, 6]) {
      act(() => result.current.addRecentlyViewed(id));
    }
    expect(result.current.recentlyViewed).toEqual([6, 5, 4, 3, 2]);
  });

  it("persists to localStorage", () => {
    const { result } = renderHook(() => useRecentlyViewed());
    act(() => result.current.addRecentlyViewed(42));
    expect(
      JSON.parse(window.localStorage.getItem("vestflow-recently-viewed") ?? "[]")
    ).toEqual([42]);
  });
});
