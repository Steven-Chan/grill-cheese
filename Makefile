.PHONY: dev gui server install

dev: gui server

gui:
	cd gui && npm run build

server:
	uv run python -m server.server

install:
	./scripts/install-hooks.sh
	mkdir -p ~/.claude/skills
	rm -rf ~/.claude/skills/grill-cheese
	cp -r skill/grill-cheese ~/.claude/skills/
