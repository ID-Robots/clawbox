NOTES = [
    {"id": 1, "title": "Groceries", "body": "milk, eggs, Bread"},
    {"id": 2, "title": "Meeting", "body": "Discuss the roadmap with the team"},
    {"id": 3, "title": "Ideas", "body": "A bread-baking app"},
]


def all_notes():
    return list(NOTES)


def get(note_id):
    for note in NOTES:
        if note["id"] == note_id:
            return note
    return None
