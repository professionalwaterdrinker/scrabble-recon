/*
 *  Tile Rewind's bridge to the Quackle engine, compiled to WebAssembly.
 *
 *  This file is part of Tile Rewind and, like Quackle, is free software:
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
 *    rack <player> <letters>         rack to analyse, '?' = blank
 *    actual <place> <word>           optional: the play that was really made
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
	o << "{\"place\":\"" << esc(m.positionString()) << "\",\"word\":\""
	  << esc(QUACKLE_ALPHABET_PARAMETERS->userVisible(m.prettyTiles())) << "\",\"tiles\":\""
	  << esc(QUACKLE_ALPHABET_PARAMETERS->userVisible(m.tiles())) << "\",\"score\":" << m.effectiveScore()
	  << ",\"equity\":" << m.equity << ",\"text\":\"" << esc(m.toString()) << "\"}";
	return o.str();
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

extern "C" {

// Load the word list and strategy files from the bundled /data folder.
int qk_init()
{
	if (dm) return 1;
	dm = new DataManager;
	dm->setAppDataDirectory("/data");
	dm->setUserDataDirectory("/data");
	dm->setBackupLexicon("default_english");
	dm->setBoardParameters(new EnglishBoard());
	dm->lexiconParameters()->loadDawg("/data/lexica/enable.dawg");
	dm->lexiconParameters()->loadGaddag("/data/lexica/enable.gaddag");
	dm->lexiconParameters()->setLexiconName("enable");
	dm->strategyParameters()->initialize("enable");
	if (!dm->lexiconParameters()->hasDawg()) return -1;
	if (!dm->lexiconParameters()->hasGaddag()) return -2;
	// 1 = ready with leave values; 2 = ready, but scoring without them
	return dm->strategyParameters()->hasSuperleaves() ? 1 : 2;
}

const char *qk_analyse(const char *input)
{
	if (!dm && qk_init() < 0) return fail("word list not loaded").c_str();

	int playerCount = 2, top = 10, rackPlayer = -1;
	struct Placed { int player; std::string place, word; };
	std::vector<Placed> moves;
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
		Move a = Move::createPlaceMove(actualPlace, QUACKLE_ALPHABET_PARAMETERS->encode(actualWord));
		const int validity = pos.validateMove(a);
		pos.scoreMove(a);
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
