/*
 *  Mabble's bridge to the Quackle engine, compiled to WebAssembly.
 *
 *  This file is part of Mabble and, like Quackle, is free software:
 *  you can redistribute it and/or modify it under the terms of the GNU
 *  General Public License as published by the Free Software Foundation,
 *  either version 3 of the License, or (at your option) any later version.
 *
 *  It replays a reconstructed game into a Quackle position and asks the
 *  engine for its best plays. Text in, JSON out, so JavaScript only needs
 *  two plain C functions.
 *
 *  Input to qk_analyse (one instruction per line):
 *    players 2
 *    move <player> <place> <word>    e.g. "move 0 8H CAT", "move 1 H7 .AT"
 *                                    '.' = tile already on the board,
 *                                    lowercase = blank
 *    hold <player> <letters>         optional: what another player is holding,
 *                                    so Quackle's bag matches the real one
 *    rack <player> <letters>         rack to analyse, '?' = blank
 *    actual <place> <word>           optional: the play that was really made
 *    actual exchange <letters>       ... or the tiles exchanged
 *    actual pass                     ... or a pass
 *    top <n>                         how many plays to return
 */

#include <sstream>
#include <string>
#include <vector>

#include "alphabetparameters.h"
#include "boardparameters.h"
#include "datamanager.h"
#include "game.h"
#include "lexiconparameters.h"
#include "move.h"
#include "player.h"
#include "playerlist.h"
#include "rack.h"
#include "strategyparameters.h"

using namespace Quackle;

static DataManager *dm = nullptr;
static std::string result;

static std::string esc(const std::string &s)
{
	std::string o;
	for (char c : s)
	{
		if (c == '"' || c == '\\') { o += '\\'; o += c; }
		else if (c == '\n') o += "\\n";
		else if ((unsigned char)c < 0x20) o += ' ';
		else o += c;
	}
	return o;
}

static std::string moveJson(const Move &m)
{
	std::ostringstream o;
	const LetterString &shown = m.prettyTiles().empty() ? m.tiles() : m.prettyTiles();
	const char *action = m.action == Move::Place ? "place" : (m.action == Move::Exchange || m.action == Move::BlindExchange) ? "exchange" : "pass";
	o << "{\"action\":\"" << action << "\",\"place\":\"" << esc(m.positionString()) << "\",\"word\":\""
	  << esc(QUACKLE_ALPHABET_PARAMETERS->userVisible(shown)) << "\",\"tiles\":\""
	  << esc(QUACKLE_ALPHABET_PARAMETERS->userVisible(m.tiles())) << "\",\"score\":" << m.effectiveScore()
	  << ",\"equity\":" << m.equity << ",\"text\":\"" << esc(m.toString()) << "\"}";
	return o.str();
}

// Put every rack back in the bag. Quackle refills racks with random draws after
// each play, and those could hold tiles we're about to give someone.
static void emptyRacks(GamePosition &pos, int playerCount)
{
	for (int i = 0; i < playerCount; ++i)
		pos.setPlayerRack(i, Rack(), true);
}

static std::string fail(const std::string &why)
{
	result = "{\"ok\":false,\"error\":\"" + esc(why) + "\"}";
	return result;
}

// The tiles a placed word takes from the rack: everything except '.', with blanks as '?'.
static std::string rackFor(const std::string &word)
{
	std::string r;
	for (char c : word)
	{
		if (c == '.') continue;
		r += (c >= 'a' && c <= 'z') ? '?' : c;
	}
	return r;
}

// The standard 15x15 board. (Quackle's EnglishBoard class is a 13x17 test board,
// and plain BoardParameters has no premium squares.) Premiums are given for one
// octant and mirrored, the same way the web app draws its board.
static BoardParameters *standardBoard()
{
	BoardParameters *b = new BoardParameters();
	b->setName(MARK_UV("Standard"));
	struct P { int r, c; bool word; int mult; };
	const P octant[] = {
		{ 0, 3, false, 2 }, { 2, 6, false, 2 }, { 3, 7, false, 2 }, { 6, 6, false, 2 },
		{ 1, 5, false, 3 }, { 5, 5, false, 3 },
		{ 1, 1, true, 2 }, { 2, 2, true, 2 }, { 3, 3, true, 2 }, { 4, 4, true, 2 }, { 7, 7, true, 2 },
		{ 0, 0, true, 3 }, { 0, 7, true, 3 },
	};
	for (const P &p : octant)
	{
		const int rr[2][2] = { { p.r, p.c }, { p.c, p.r } };
		for (const auto &rc : rr)
			for (int row : { rc[0], 14 - rc[0] })
				for (int col : { rc[1], 14 - rc[1] })
				{
					if (p.word) b->setWordMultiplier(row, col, (BoardParameters::WordMultiplier)p.mult);
					else b->setLetterMultiplier(row, col, (BoardParameters::LetterMultiplier)p.mult);
				}
	}
	return b;
}

extern "C" {

// Load the word list and strategy files from the bundled /data folder.
int qk_init()
{
	if (dm) return 1;
	dm = new DataManager;
	dm->setAppDataDirectory("/data");
	dm->setUserDataDirectory("/data");
	dm->setBackupLexicon("default_english");
	dm->setBoardParameters(standardBoard());
	dm->lexiconParameters()->loadDawg("/data/lexica/enable.dawg");
	dm->lexiconParameters()->loadGaddag("/data/lexica/enable.gaddag");
	dm->lexiconParameters()->setLexiconName("enable");
	dm->strategyParameters()->initialize("enable");
	if (!dm->lexiconParameters()->hasDawg()) return -1;
	if (!dm->lexiconParameters()->hasGaddag()) return -2;
	// 1 = ready with leave values; 2 = ready, but scoring without them
	return dm->strategyParameters()->hasSuperleaves() ? 1 : 2;
}

// Switch to a word list the page has written into the virtual file system (a DAWG
// only: Quackle can find moves without a GADDAG, just more slowly). `lexicon` names
// it for strategy lookups: names starting "csw" use Quackle's Collins leave values
// from /data/strategy/csw/ when the page has provided them.
int qk_use_lexicon(const char *dawgPath, const char *lexicon)
{
	if (!dm && qk_init() < 0) return -1;
	LexiconParameters *lex = dm->lexiconParameters();
	lex->unloadAll();
	lex->loadDawg(dawgPath);
	lex->setLexiconName(lexicon);
	dm->strategyParameters()->initialize(lexicon);
	return lex->hasDawg() ? 1 : -1;
}

// Back to the bundled ENABLE word list.
int qk_use_builtin()
{
	if (!dm) return qk_init();
	LexiconParameters *lex = dm->lexiconParameters();
	lex->unloadAll();
	lex->loadDawg("/data/lexica/enable.dawg");
	lex->loadGaddag("/data/lexica/enable.gaddag");
	lex->setLexiconName("enable");
	dm->strategyParameters()->initialize("enable");
	return lex->hasDawg() && lex->hasGaddag() ? 1 : -1;
}

const char *qk_analyse(const char *input)
{
	if (!dm && qk_init() < 0) return fail("word list not loaded").c_str();

	int playerCount = 2, top = 10, rackPlayer = -1;
	struct Placed { int player; std::string place, word; };
	std::vector<Placed> moves;
	std::vector<std::pair<int, std::string>> holds;
	std::string rackText, actualPlace, actualWord;

	std::istringstream in(input);
	std::string line;
	while (std::getline(in, line))
	{
		std::istringstream ls(line);
		std::string cmd;
		ls >> cmd;
		if (cmd == "players") ls >> playerCount;
		else if (cmd == "top") ls >> top;
		else if (cmd == "move") { Placed p; ls >> p.player >> p.place >> p.word; moves.push_back(p); }
		else if (cmd == "rack") ls >> rackPlayer >> rackText;
		else if (cmd == "hold") { int p = -1; std::string t; ls >> p >> t; if (p >= 0 && !t.empty()) holds.push_back({ p, t }); }
		else if (cmd == "actual") ls >> actualPlace >> actualWord;
	}
	if (playerCount < 2 || playerCount > 4) return fail("players must be 2 to 4").c_str();
	if (rackPlayer < 0 || rackPlayer >= playerCount || rackText.empty()) return fail("missing rack").c_str();

	Game game;
	PlayerList players;
	for (int i = 0; i < playerCount; ++i)
		players.push_back(Player(MARK_UV("Player ") + std::to_string(i + 1), Player::HumanPlayerType, i));
	game.setPlayers(players);
	game.addPosition();

	// Replay the game: give each player exactly the tiles they played, then play them.
	for (size_t k = 0; k < moves.size(); ++k)
	{
		const Placed &p = moves[k];
		GamePosition &pos = game.currentPosition();
		emptyRacks(pos, playerCount);
		pos.setCurrentPlayer(p.player);
		pos.setCurrentPlayerRack(Rack(QUACKLE_ALPHABET_PARAMETERS->encode(rackFor(p.word))));
		Move m = Move::createPlaceMove(p.place, QUACKLE_ALPHABET_PARAMETERS->encode(p.word));
		const int validity = pos.validateMove(m);
		if (validity & (GamePosition::InvalidTiles | GamePosition::InvalidPlace | GamePosition::InvalidOpeningPlace))
			return fail("move " + std::to_string(k + 1) + " (" + p.place + " " + p.word + ") doesn't fit the board").c_str();
		pos.scoreMove(m);
		game.commitMove(m);
	}

	GamePosition &pos = game.currentPosition();
	emptyRacks(pos, playerCount);
	for (const auto &h : holds)
		if (h.first != rackPlayer && h.first < playerCount)
			pos.setPlayerRack(h.first, Rack(QUACKLE_ALPHABET_PARAMETERS->encode(h.second)), true);
	pos.setCurrentPlayer(rackPlayer);
	pos.setCurrentPlayerRack(Rack(QUACKLE_ALPHABET_PARAMETERS->encode(rackText)));
	pos.kibitz(top);
	const MoveList &list = pos.moves();

	std::ostringstream o;
	o << "{\"ok\":true,\"rack\":\"" << esc(rackText) << "\",\"moves\":[";
	for (size_t i = 0; i < list.size(); ++i)
		o << (i ? "," : "") << moveJson(list[i]);
	o << "]";

	if (!actualPlace.empty())
	{
		Move a = actualPlace == "exchange" ? Move::createExchangeMove(QUACKLE_ALPHABET_PARAMETERS->encode(actualWord), false)
			: actualPlace == "pass" ? Move::createPassMove()
			: Move::createPlaceMove(actualPlace, QUACKLE_ALPHABET_PARAMETERS->encode(actualWord));
		const int validity = pos.validateMove(a);
		if (a.action == Move::Place) pos.scoreMove(a);
		a.equity = pos.calculateEquity(a);
		int rank = -1;
		for (size_t i = 0; i < list.size(); ++i)
			if (list[i] == a) { rank = (int)i; break; }
		o << ",\"actual\":" << moveJson(a) << ",\"actualRank\":" << rank << ",\"actualValidity\":" << validity;
	}
	o << "}";
	result = o.str();
	return result.c_str();
}

}
