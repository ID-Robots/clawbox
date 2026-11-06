import argparse

from notes import store


def cmd_list(args):
    for note in store.all_notes():
        print(f"{note['id']}: {note['title']}")
    return 0


def cmd_show(args):
    note = store.get(args.id)
    if note is None:
        print("not found")
        return 1
    print(note["title"])
    print(note["body"])
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="notes")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list").set_defaults(func=cmd_list)
    show = sub.add_parser("show")
    show.add_argument("id", type=int)
    show.set_defaults(func=cmd_show)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)
