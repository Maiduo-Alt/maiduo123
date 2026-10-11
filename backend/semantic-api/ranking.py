from __future__ import annotations

from typing import List, Sequence


def cosine(left: Sequence[float], right: Sequence[float]) -> float:
    left_norm = sum(value * value for value in left) ** 0.5
    right_norm = sum(value * value for value in right) ** 0.5
    if not left_norm or not right_norm or len(left) != len(right):
        return 0.0
    return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)


def rank_candidates(query: Sequence[float], candidates, embeddings, min_score: float):
    matches = []
    for candidate, embedding in zip(candidates, embeddings):
        score = cosine(query, embedding)
        if score >= min_score:
            matches.append({"id": candidate["id"], "score": round(score, 4)})
    return sorted(matches, key=lambda item: item["score"], reverse=True)
